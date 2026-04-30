"""Realized capital-gain / wash-sale calculator.

Pure functions — no DB or HTTP dependencies. Given a chronologically
ordered list of investment transactions (buys + sells), produce:

  - per-sell `match` records: which buy lot(s) covered the sale, the
    holding period of each match, the gain or loss, and whether the
    loss was disallowed under IRC §1091 (wash sale rule)
  - aggregate YTD summary: realized ST gain / loss, realized LT gain /
    loss, disallowed wash-sale loss, estimated tax owed at the user's
    marginal bracket
  - per-open-position metadata: cost basis, days-until-long-term, the
    tax delta if held to LT vs sold today

Conventions match Plaid's investment_transactions schema:
  - quantity is POSITIVE for buys, NEGATIVE for sells
  - price is per-share
  - amount is the cash impact (positive = cash leaving the account on
    a buy, negative = cash entering on a sell)
  - We treat fees as added-to-basis on buys and subtracted-from-proceeds
    on sells (the standard cost-basis convention)

Algorithm:
  - Group transactions by symbol (Plaid security id)
  - For each symbol, walk transactions in chronological order:
      buy → push a Lot onto an open-lots queue (FIFO by default)
      sell → pop lots from the queue until the sell qty is satisfied,
              recording one match per consumed lot
  - After all matches are recorded, run a wash-sale pass:
      for each loss match, scan the symbol's transactions for any BUY
      of that symbol within 30 days BEFORE the sell date or 30 days
      AFTER. If found, mark the disallowed loss and roll the disallowed
      amount into the basis of the qualifying replacement buy lot.

What we model:
  - FIFO matching (the default for nearly every brokerage including
    Robinhood; specific-identification can be added later).
  - 31-day window on either side of the sell (IRS §1091 is "30 days
    before or after," interpreted inclusively → 31 days each side).
  - Holding period = sell_date - buy_date. > 365 days = LT, else ST.
  - Wash sale disallowed loss is added to the basis of the replacement
    buy lot, NOT permanently lost (it just defers the deduction).

What we do NOT model (yet):
  - Substantially identical securities beyond exact symbol match
    (options on the same underlying, different ETFs tracking the same
    index, etc. — much more complex, requires a substantial-similarity
    table; safe-conservative is "exact symbol only").
  - IRA wash sales (these are permanently disallowed under Rev. Rul.
    2008-5; we'd need to look at account.tax_bucket to apply that).
    For taxable accounts the standard rule applies as modeled.
  - Dividend reinvestment as wash-sale-triggering buys (it does count
    under IRS rules but DRIP txns from Plaid are usually flagged
    type='dividend' subtype='dividend' — the caller can include them
    if they want them treated as wash-triggering buys).
"""
from __future__ import annotations

import datetime
from collections import defaultdict, deque
from dataclasses import dataclass, field
from typing import Optional


# Holding-period boundary. IRS rule: > 1 year for LT treatment.
# We use strictly > 365 days (i.e., day 366+) to be conservative —
# leap years and the "one year and one day" common-law reading both
# work out to the same answer for the cases that matter.
LT_DAYS = 366

# Wash sale window — 30 days BEFORE or AFTER the loss sale.
# IRS uses "during the 61-day period beginning 30 days before the
# date of the sale and ending 30 days after." We use ±30 inclusive
# = a 61-day window total.
WASH_WINDOW_DAYS = 30


@dataclass
class Lot:
    """An open buy lot — depleted by sells in FIFO order. The
    `disallowed_basis_added` field accumulates wash-sale adjustments
    that the IRS rolls forward into the replacement lot's basis.
    `account_id` tracks which account the lot lives in — brokerages
    report 1099-Bs per account with per-account FIFO, so we mirror
    that here for reconciliation."""
    buy_date: datetime.date
    quantity: float
    cost_per_share: float            # includes pro-rata fees
    plaid_txn_id: Optional[str] = None
    account_id: Optional[int] = None
    disallowed_basis_added: float = 0.0  # wash-sale adjustments


@dataclass
class Match:
    """One sell-to-buy match. A single sell can produce multiple
    matches when it spans multiple lots."""
    symbol: str
    sell_date: datetime.date
    buy_date: datetime.date
    quantity: float
    proceeds: float                  # per-share net of pro-rata sell fees, × qty
    basis: float                     # per-share cost (including disallowed adjustments) × qty
    gain_loss: float                 # proceeds - basis
    holding_period_days: int
    term: str                        # 'ST' or 'LT'
    wash_sale_disallowed: float = 0.0  # 0.0 if not a wash sale; > 0 = disallowed loss amount
    sell_txn_id: Optional[str] = None
    buy_txn_id: Optional[str] = None
    # Account this match belongs to. Lets the UI scope a per-account
    # display while the underlying calculation still considers the full
    # taxpayer-wide picture for wash-sale purposes.
    account_id: Optional[int] = None
    # When the wash-sale replacement buy is in a DIFFERENT account
    # (the cross-account case — e.g. selling in a brokerage and buying
    # in an IRA), surface that for the UI to flag specially. If both
    # are in the same account, this is None.
    wash_sale_replacement_account_id: Optional[int] = None
    # Plaid txn id of the replacement BUY that absorbed this loss's
    # disallowance. Lets the summary distinguish "disallowed but the
    # replacement lot is still open" (loss truly stuck this year) vs
    # "disallowed but the replacement lot was sold downstream" (loss
    # captured via inflated basis). Without this, the headline tile
    # double-counts each chain link.
    wash_sale_replacement_txn_id: Optional[str] = None


@dataclass
class OpenPosition:
    """An open lot still held at the as-of date — surface to the UI as
    'X days until long-term' + tax-savings-if-held. One entry per
    (account, security) pair so the user sees AAPL-in-Robinhood and
    AAPL-in-IRA as separate rows, matching the brokerage 1099-B view."""
    symbol: str
    plaid_security_id: str           # stable identifier; symbol is display-only
    account_id: Optional[int]        # None only for legacy callers without account context
    quantity: float
    cost_basis: float                # total $, all lots in this (account, security) group
    avg_cost_per_share: float
    earliest_buy_date: datetime.date  # used to compute LT countdown
    days_held_so_far: int
    days_until_lt: int               # 0 if already LT
    is_long_term: bool


WASH_SCOPE_ALL_ACCOUNTS = "all_accounts"        # IRS rule (default) — taxpayer-wide
WASH_SCOPE_PER_ACCOUNT = "per_account"          # Broker-style — per-account only
WASH_SCOPE_SELECTED = "selected_accounts"       # Bounded — only the user's selected set


def compute_realized_pnl(
    transactions: list[dict],
    as_of: Optional[datetime.date] = None,
    wash_sale_scope: str = WASH_SCOPE_ALL_ACCOUNTS,
    wash_sale_account_ids: Optional[set] = None,
) -> dict:
    """Walk transactions, produce match records + open lots + summary.

    Each transaction dict expects:
      - 'date' (datetime.date)
      - 'plaid_security_id' (str) — symbol grouping key
      - 'symbol' (str, optional) — for display only; falls back to security_id
      - 'type' (str) — 'buy' or 'sell' (others ignored)
      - 'quantity' (float, positive)
      - 'price' (float, per-share, positive)
      - 'fees' (float, optional, default 0)
      - 'plaid_investment_transaction_id' (str, optional) — for traceability

    Returns:
      {
        'matches': [Match, ...],            # one per buy-lot consumed
        'open_positions': [OpenPosition, ...],
        'summary': {
            'st_gain': float,    # > 0 = net gain, < 0 = net loss
            'st_loss': float,
            'lt_gain': float,
            'lt_loss': float,
            'wash_sale_disallowed': float,  # total disallowed
            'net_realized': float,          # st + lt, after wash-sale adjustments
            ...
        }
      }
    """
    if as_of is None:
        as_of = datetime.date.today()

    # ── Group by (account_id, security_id) for FIFO matching ──
    # Brokerages report 1099-Bs PER ACCOUNT with their own per-account
    # FIFO lot tracking, so our matches must mirror that structure for
    # the user's tax-time reconciliation to line up.
    #
    # Wash-sale scoping (further down) is configurable:
    #   WASH_SCOPE_ALL_ACCOUNTS (default): scan ALL accounts' buys
    #     for the same security. Matches IRC §1091 + Rev. Rul. 2008-5
    #     — the rule applies per taxpayer.
    #   WASH_SCOPE_PER_ACCOUNT: only scan buys in the SAME account as
    #     the loss. Matches what brokerages enforce on 1099-Bs (each
    #     broker only sees their own accounts). Less conservative than
    #     the IRS rule; useful when retirement accounts can't possibly
    #     hold the same individual securities being traded.
    by_account_symbol: dict[tuple, list[dict]] = defaultdict(list)
    # Buy indexes for wash-sale scanning. We build BOTH variants so
    # the scope toggle is just a lookup choice rather than a re-pass.
    buys_by_security: dict[str, list[tuple[datetime.date, dict]]] = defaultdict(list)
    buys_by_account_security: dict[tuple, list[tuple[datetime.date, dict]]] = defaultdict(list)
    for t in transactions:
        sec_id = t.get("plaid_security_id")
        if not sec_id:
            continue  # cash-only / unmapped transactions skipped
        ttype = (t.get("type") or "").lower()
        if ttype not in ("buy", "sell"):
            continue
        by_account_symbol[(t.get("account_id"), sec_id)].append(t)
        if ttype == "buy":
            buys_by_security[sec_id].append((t["date"], t))
            buys_by_account_security[(t.get("account_id"), sec_id)].append((t["date"], t))
    for k in by_account_symbol:
        by_account_symbol[k].sort(key=lambda t: (t["date"], t.get("plaid_investment_transaction_id") or ""))

    # ── Chronological interleaved pass ──
    # Process all (buy, sell) txns in date order, doing wash detection
    # inline. This is the difference between this v2 and the older
    # pass-1-FIFO-then-pass-2-wash design: when a buy at T+5 triggers
    # wash on a loss-sell at T, the disallowed amount lands on the new
    # lot's `disallowed_basis_added` BEFORE any future sell consumes it,
    # so the chain propagates to all downstream matches' bases.
    #
    # Forward wash (buy after loss-sell): for each new buy, scan recent
    # loss-matches in the wash window and disallow any unwashed losses
    # whose security matches and whose scope allows.
    #
    # Backward wash (buy before loss-sell): for each new loss-match,
    # scan the open lots queue for a recent buy in the window. The
    # critical point is that for the BACKWARD case we may also need to
    # surface a wash even when the prior buy's lot has been fully
    # consumed by an earlier sell — IRS treats it as a wash regardless.
    # In that case we mark the disallowance but can't roll basis into a
    # consumed lot; the wash_sale_disallowed_captured tile reflects that.
    sortable_txns = []
    for t in transactions:
        sec_id = t.get("plaid_security_id")
        if not sec_id:
            continue
        ttype = (t.get("type") or "").lower()
        if ttype not in ("buy", "sell"):
            continue
        sortable_txns.append(t)
    sortable_txns.sort(key=lambda t: (
        t["date"], 0 if (t.get("type") or "").lower() == "buy" else 1,
        t.get("plaid_investment_transaction_id") or "",
    ))

    matches: list[Match] = []
    open_lots_by_group: dict[tuple, deque[Lot]] = {}
    # Symbol label cache, derived from the first txn that has one.
    symbol_labels: dict[str, str] = {}
    for t in sortable_txns:
        sec_id = t["plaid_security_id"]
        if t.get("symbol") and sec_id not in symbol_labels:
            symbol_labels[sec_id] = t["symbol"]

    def _label(sec_id: str) -> str:
        return symbol_labels.get(sec_id, sec_id)

    def _scope_allows(loss_account_id, replacement_account_id) -> bool:
        """Check the configured wash-sale scope against this pairing."""
        if wash_sale_scope == WASH_SCOPE_PER_ACCOUNT:
            return loss_account_id == replacement_account_id
        if wash_sale_scope == WASH_SCOPE_SELECTED and wash_sale_account_ids:
            return replacement_account_id in wash_sale_account_ids
        return True  # ALL_ACCOUNTS (or SELECTED with no set → fall through)

    for t in sortable_txns:
        date = t["date"]
        sec_id = t["plaid_security_id"]
        ttype = t["type"].lower()
        acct_id = t.get("account_id")
        qty = abs(float(t.get("quantity") or 0))
        price = float(t.get("price") or 0)
        fees = float(t.get("fees") or 0)
        if qty <= 0 or price <= 0:
            continue
        txn_id = t.get("plaid_investment_transaction_id")

        if ttype == "buy":
            cost_per_share = price + (fees / qty if qty > 0 else 0)
            new_lot = Lot(
                buy_date=date,
                quantity=qty,
                cost_per_share=cost_per_share,
                plaid_txn_id=txn_id,
                account_id=acct_id,
            )

            # Forward wash: this buy may disallow recent loss matches
            # whose sell happened within 30 days BEFORE this buy date.
            # The disallowed loss goes into THIS new lot's basis, so
            # any future sell that consumes this lot will see the
            # inflated basis (chain propagation).
            wash_window_start = date - datetime.timedelta(days=WASH_WINDOW_DAYS)
            for prior in reversed(matches):
                # Matches are appended in chronological order, so once
                # we go past the window we can stop.
                if prior.sell_date < wash_window_start:
                    break
                if prior.symbol != _label(sec_id):
                    # Symbol-label is set per security — same sec_id
                    # always produces same label. So this check works
                    # for security identity at the labeling layer.
                    continue
                if prior.gain_loss >= 0:
                    continue
                if prior.wash_sale_disallowed > 0:
                    continue  # already washed by an earlier replacement
                if not _scope_allows(prior.account_id, acct_id):
                    continue
                # Skip if this buy IS the originating buy of the loss
                # match (can't be a "replacement" for itself).
                if txn_id and txn_id == prior.buy_txn_id:
                    continue
                disallowed = round(-prior.gain_loss, 2)
                prior.wash_sale_disallowed = disallowed
                prior.wash_sale_replacement_txn_id = txn_id
                if prior.account_id != acct_id:
                    prior.wash_sale_replacement_account_id = acct_id
                new_lot.disallowed_basis_added += disallowed

            open_lots_by_group.setdefault((acct_id, sec_id), deque()).append(new_lot)

        elif ttype == "sell":
            remaining = qty
            proceeds_per_share = price - (fees / qty if qty > 0 else 0)
            new_matches: list[Match] = []
            lots = open_lots_by_group.setdefault((acct_id, sec_id), deque())

            # FIFO from this account's lot queue. Basis includes any
            # disallowed_basis_added that was rolled in by prior wash
            # detections.
            while remaining > 1e-9 and lots:
                lot = lots[0]
                take = min(remaining, lot.quantity)
                basis_per_share = lot.cost_per_share + (
                    lot.disallowed_basis_added / lot.quantity if lot.quantity > 0 else 0
                )
                match_proceeds = take * proceeds_per_share
                match_basis = take * basis_per_share
                holding = (date - lot.buy_date).days
                m = Match(
                    symbol=_label(sec_id),
                    sell_date=date,
                    buy_date=lot.buy_date,
                    quantity=take,
                    proceeds=round(match_proceeds, 2),
                    basis=round(match_basis, 2),
                    gain_loss=round(match_proceeds - match_basis, 2),
                    holding_period_days=holding,
                    term="LT" if holding >= LT_DAYS else "ST",
                    sell_txn_id=txn_id,
                    buy_txn_id=lot.plaid_txn_id,
                    account_id=acct_id,
                )
                matches.append(m)
                new_matches.append(m)
                lot.quantity -= take
                # Drain disallowance proportionally so the per-share
                # adjustment stays constant as shares come out.
                if lot.disallowed_basis_added and lot.quantity > 0:
                    consumed_pct = take / (take + lot.quantity)
                    lot.disallowed_basis_added *= (1 - consumed_pct)
                elif lot.quantity <= 0:
                    lot.disallowed_basis_added = 0.0
                if lot.quantity <= 1e-9:
                    lots.popleft()
                remaining -= take

            # Cross-account transfer reconciliation: if still oversold,
            # pull from other accounts' open lots (existing helper).
            if remaining > 1e-9:
                cross_pulled = _consume_from_other_accounts(
                    sell_qty_remaining=remaining,
                    sell_account_id=acct_id,
                    sec_id=sec_id,
                    sell_date=date,
                    sell_txn_id=txn_id,
                    proceeds_per_share=proceeds_per_share,
                    symbol_label=_label(sec_id),
                    open_lots_by_group=open_lots_by_group,
                    matches=matches,
                )
                # Pulled matches are appended to `matches` (and we want
                # them in `new_matches` too for backward-wash scanning).
                # The helper appends to `matches`; copy the tail.
                added_count = len(matches) - len(new_matches) - sum(
                    1 for _ in []  # placeholder; matches.copy() below
                )
                # Simpler: collect all matches added since this sell
                # started by re-scanning matches[-N:] where N is the
                # number added in both the local FIFO and cross-account.
                while len(new_matches) < (
                    len([m for m in matches if m.sell_txn_id == txn_id])
                ):
                    # Find the next match for this sell that's not yet
                    # in new_matches (cross-account additions).
                    for m_candidate in matches:
                        if m_candidate.sell_txn_id == txn_id and m_candidate not in new_matches:
                            new_matches.append(m_candidate)
                            break
                    else:
                        break
                remaining -= cross_pulled
                # If STILL remaining → silently dropped (data error).

            # Backward wash: for each loss match created by this sell,
            # look for a buy of the same security within 30 days BEFORE
            # this sell that's not the originating buy. If found, mark
            # this match as washed and roll into that buy's lot's
            # disallowed_basis_added (if the lot is still open).
            wash_window_start = date - datetime.timedelta(days=WASH_WINDOW_DAYS)
            for m in new_matches:
                if m.gain_loss >= 0:
                    continue
                # Search open lots across all accounts for a recent buy
                # in this security. We want the OLDEST qualifying buy
                # in the window so the wash attribution is stable.
                replacement_lot = None
                for (a, s), lot_q in open_lots_by_group.items():
                    if s != sec_id:
                        continue
                    if not _scope_allows(m.account_id, a):
                        continue
                    for lot in lot_q:
                        if lot.buy_date < wash_window_start:
                            continue
                        if lot.buy_date > date:
                            continue  # forward wash already handled above
                        if lot.plaid_txn_id == m.buy_txn_id:
                            continue  # the originating buy
                        if replacement_lot is None or lot.buy_date < replacement_lot.buy_date:
                            replacement_lot = lot
                            break  # oldest in this group is fine
                if replacement_lot is None:
                    continue
                disallowed = round(-m.gain_loss, 2)
                m.wash_sale_disallowed = disallowed
                m.wash_sale_replacement_txn_id = replacement_lot.plaid_txn_id
                if m.account_id != replacement_lot.account_id:
                    m.wash_sale_replacement_account_id = replacement_lot.account_id
                replacement_lot.disallowed_basis_added += disallowed

    # ── Open positions per (account, security) ──
    # One row per (account, security) pair so the user sees AAPL-in-
    # Robinhood and AAPL-in-IRA as separate rows, matching brokerage
    # 1099-B reporting and per-account FIFO behavior.
    open_positions: list[OpenPosition] = []
    for (acct_id, sec_id), lots in open_lots_by_group.items():
        if not lots:
            continue
        total_qty = sum(l.quantity for l in lots)
        total_basis = sum(
            l.quantity * l.cost_per_share + l.disallowed_basis_added
            for l in lots
        )
        if total_qty <= 0:
            continue
        earliest = min(l.buy_date for l in lots)
        days_held = (as_of - earliest).days
        days_until_lt = max(0, LT_DAYS - days_held)
        symbol_label = next(
            (t.get("symbol") for t in by_account_symbol.get((acct_id, sec_id), []) if t.get("symbol")),
            sec_id,
        )
        open_positions.append(OpenPosition(
            symbol=symbol_label,
            plaid_security_id=sec_id,
            account_id=acct_id,
            quantity=round(total_qty, 6),
            cost_basis=round(total_basis, 2),
            avg_cost_per_share=round(total_basis / total_qty, 4) if total_qty > 0 else 0.0,
            earliest_buy_date=earliest,
            days_held_so_far=days_held,
            days_until_lt=days_until_lt,
            is_long_term=days_until_lt == 0,
        ))

    # ── Aggregate summary ──
    st_gain = sum(m.gain_loss for m in matches if m.term == "ST" and m.gain_loss > 0)
    st_loss = sum(
        m.gain_loss + m.wash_sale_disallowed
        for m in matches if m.term == "ST" and m.gain_loss < 0
    )
    lt_gain = sum(m.gain_loss for m in matches if m.term == "LT" and m.gain_loss > 0)
    lt_loss = sum(
        m.gain_loss + m.wash_sale_disallowed
        for m in matches if m.term == "LT" and m.gain_loss < 0
    )
    wash_disallowed = sum(m.wash_sale_disallowed for m in matches)

    # Split the wash-disallowed total into "locked" vs "captured":
    #   LOCKED   = the replacement lot is still OPEN (deduction truly
    #              deferred — basis adjustment sits on a position that
    #              hasn't been sold yet, so the loss can't be realized
    #              until you sell that lot in a future transaction).
    #   CAPTURED = the replacement lot has been fully consumed by some
    #              later sell. The disallowed amount has been (or will
    #              be, on the next match recompute) re-incorporated into
    #              that downstream sell's basis. Counting these as
    #              "still locked" overstates the picture — the loss is
    #              effectively still in the system, just attributed to a
    #              different match line.
    # The headline tile becomes honest: a fully-closed-out chain reads
    # locked=$0, even though the gross disallowance event sum is large.
    open_lot_txn_ids: set[Optional[str]] = set()
    for lots in open_lots_by_group.values():
        for lot in lots:
            if lot.plaid_txn_id and lot.quantity > 1e-9:
                open_lot_txn_ids.add(lot.plaid_txn_id)
    wash_locked = 0.0
    wash_captured = 0.0
    for m in matches:
        if m.wash_sale_disallowed <= 0:
            continue
        if m.wash_sale_replacement_txn_id in open_lot_txn_ids:
            wash_locked += m.wash_sale_disallowed
        else:
            wash_captured += m.wash_sale_disallowed

    return {
        "matches": matches,
        "open_positions": sorted(
            open_positions, key=lambda p: p.earliest_buy_date,
        ),
        "summary": {
            "st_gain": round(st_gain, 2),
            "st_loss": round(st_loss, 2),
            "st_net": round(st_gain + st_loss, 2),
            "lt_gain": round(lt_gain, 2),
            "lt_loss": round(lt_loss, 2),
            "lt_net": round(lt_gain + lt_loss, 2),
            "wash_sale_disallowed": round(wash_disallowed, 2),
            "wash_sale_disallowed_locked": round(wash_locked, 2),
            "wash_sale_disallowed_captured": round(wash_captured, 2),
            "net_realized": round(st_gain + st_loss + lt_gain + lt_loss, 2),
            "match_count": len(matches),
            "open_position_count": len(open_positions),
        },
    }


def _consume_from_other_accounts(
    sell_qty_remaining: float,
    sell_account_id,
    sec_id: str,
    sell_date: datetime.date,
    sell_txn_id: Optional[str],
    proceeds_per_share: float,
    symbol_label: str,
    open_lots_by_group: dict,
    matches: list,
) -> float:
    """Pull shares from OTHER accounts' open lots to satisfy a sell
    that overran the local account's inventory. Used to reconcile
    inter-account transfers — when shares move from account A to
    account B, Plaid records the buys and sells on each side but
    doesn't always emit a clean 'transfer' event. The result is
    account B has a sell with no local lot to consume; this function
    finds the source lot in account A and pairs them.

    Strategy: scan every (other_account, sec_id) group with open lots
    of THIS security, sorted by buy date (oldest first — same FIFO
    logic, just across accounts). Consume from each lot until the
    remaining sell quantity is satisfied or no more lots exist.

    Each consumed slice produces a Match with `account_id` set to the
    SELLING account (where the tax event landed) but `buy_txn_id`
    pointing to the source lot — so the audit trail explains where
    the shares came from.

    Returns the quantity actually consumed (may be less than
    sell_qty_remaining if no other accounts had enough open shares).
    """
    consumed = 0.0
    # Find all open-lot groups for the same security in OTHER accounts.
    # Sort by oldest lot's buy date so FIFO across accounts is stable.
    candidate_groups = sorted(
        [
            (a_id, lots)
            for (a_id, s), lots in open_lots_by_group.items()
            if s == sec_id and a_id != sell_account_id and lots
        ],
        key=lambda kv: min(l.buy_date for l in kv[1]) if kv[1] else datetime.date.max,
    )
    for source_acct_id, lots in candidate_groups:
        while sell_qty_remaining > 1e-9 and lots:
            lot = lots[0]
            take = min(sell_qty_remaining, lot.quantity)
            basis_per_share = lot.cost_per_share + (
                lot.disallowed_basis_added / lot.quantity if lot.quantity > 0 else 0
            )
            match_proceeds = take * proceeds_per_share
            match_basis = take * basis_per_share
            holding = (sell_date - lot.buy_date).days
            matches.append(Match(
                symbol=symbol_label,
                sell_date=sell_date,
                buy_date=lot.buy_date,
                quantity=take,
                proceeds=round(match_proceeds, 2),
                basis=round(match_basis, 2),
                gain_loss=round(match_proceeds - match_basis, 2),
                holding_period_days=holding,
                term="LT" if holding >= LT_DAYS else "ST",
                sell_txn_id=sell_txn_id,
                buy_txn_id=lot.plaid_txn_id,
                # account_id = the SELLING account (where the tax
                # event lands). The fact that the lot came from
                # another account is preserved via buy_txn_id.
                account_id=sell_account_id,
            ))
            lot.quantity -= take
            consumed += take
            sell_qty_remaining -= take
            if lot.disallowed_basis_added and lot.quantity > 0:
                share_consumed_pct = take / (take + lot.quantity)
                lot.disallowed_basis_added *= (1 - share_consumed_pct)
            elif lot.quantity <= 0:
                lot.disallowed_basis_added = 0.0
            if lot.quantity <= 1e-9:
                lots.popleft()
        if sell_qty_remaining <= 1e-9:
            break
    return consumed


def _find_replacement_buy(
    sec_id: str,
    sell_date: datetime.date,
    sell_txn_id: Optional[str],
    matched_buy_txn_id: Optional[str],
    buys: list[tuple[datetime.date, dict]],
    open_lots: list[Lot],
) -> Optional[dict]:
    """Find any qualifying replacement buy in the wash-sale window
    (sell_date ± 30 days inclusive). Returns the buy txn dict if found,
    else None.

    'Qualifying' = a buy of the same symbol within the window that is
    NOT the originating buy of the loss match (the buy that provided
    the sold shares is the SOURCE, not a replacement). We exclude:
      - matched_buy_txn_id (the source of the sold shares)
      - sell_txn_id (a sell isn't a buy, but defensive)
    """
    window_start = sell_date - datetime.timedelta(days=WASH_WINDOW_DAYS)
    window_end = sell_date + datetime.timedelta(days=WASH_WINDOW_DAYS)
    for buy_date, buy_txn in buys:
        if not (window_start <= buy_date <= window_end):
            continue
        bid = buy_txn.get("plaid_investment_transaction_id")
        if bid == matched_buy_txn_id:
            continue  # this is the originating buy, not a replacement
        if bid == sell_txn_id:
            continue
        return buy_txn
    return None


def estimate_tax_owed(
    summary: dict,
    ordinary_marginal_rate: float = 0.22,
    ltcg_rate: float = 0.15,
    state_rate: float = 0.0425,
) -> dict:
    """Rough estimated tax owed on YTD realized trading activity.

    ST gains tax at ordinary marginal + state.
    LT gains tax at federal LTCG bracket + state (most states tax LTCG
    as ordinary; MI does — that's the conservative default).
    Net losses (after wash-sale adjustments) offset other gains first,
    then up to $3,000/yr against ordinary income; excess carries
    forward (not modeled here — see the capital-loss carryover tracker
    on the Investments page for the carryover ledger).

    Returns a dict with the per-component tax owed plus a single
    estimated_tax_total the UI can surface as the headline number.
    """
    st_net = summary.get("st_net", 0)
    lt_net = summary.get("lt_net", 0)

    # Net ST and LT against each other before computing tax.
    # ST gains can be reduced by LT losses and vice versa per IRS netting.
    net_st = st_net
    net_lt = lt_net
    if net_st > 0 and net_lt < 0:
        offset = min(net_st, -net_lt)
        net_st -= offset
        net_lt += offset
    elif net_lt > 0 and net_st < 0:
        offset = min(net_lt, -net_st)
        net_lt -= offset
        net_st += offset

    # Apply ordinary-income offset cap on net losses ($3,000/yr).
    NET_LOSS_CAP = 3000.0
    if net_st + net_lt < 0:
        # Net loss — only first $3k is currently deductible against
        # ordinary income; the rest carries forward (tracked separately).
        deductible_loss = max(net_st + net_lt, -NET_LOSS_CAP)
        st_tax = deductible_loss * (ordinary_marginal_rate + state_rate)  # negative = refund-side savings
        return {
            "st_tax_federal": round(deductible_loss * ordinary_marginal_rate, 2),
            "st_tax_state": round(deductible_loss * state_rate, 2),
            "lt_tax_federal": 0.0,
            "lt_tax_state": 0.0,
            "estimated_tax_total": round(st_tax, 2),
            "carryover_to_next_year": round((net_st + net_lt) - deductible_loss, 2),
        }

    st_tax_fed = max(0.0, net_st) * ordinary_marginal_rate
    st_tax_state = max(0.0, net_st) * state_rate
    lt_tax_fed = max(0.0, net_lt) * ltcg_rate
    lt_tax_state = max(0.0, net_lt) * state_rate

    return {
        "st_tax_federal": round(st_tax_fed, 2),
        "st_tax_state": round(st_tax_state, 2),
        "lt_tax_federal": round(lt_tax_fed, 2),
        "lt_tax_state": round(lt_tax_state, 2),
        "estimated_tax_total": round(
            st_tax_fed + st_tax_state + lt_tax_fed + lt_tax_state, 2
        ),
        "carryover_to_next_year": 0.0,
    }


def lt_savings_per_position(
    open_positions: list[OpenPosition],
    current_prices: dict[str, float],  # symbol → price
    ordinary_marginal_rate: float = 0.22,
    ltcg_rate: float = 0.15,
    state_rate: float = 0.0425,
) -> list[dict]:
    """For each open position currently sitting at a gain, compute the
    tax-savings dollar amount if you HOLD until long-term vs sell today
    (assuming current price holds). The killer-feature input for the
    'days until LT' tile.

    Returns sorted descending by savings amount so the UI can surface
    the highest-leverage ones first.
    """
    out = []
    for p in open_positions:
        if p.is_long_term:
            continue  # already LT
        price = current_prices.get(p.symbol)
        if not price or price <= 0:
            continue
        proceeds = p.quantity * price
        gain = proceeds - p.cost_basis
        if gain <= 0:
            continue  # only positive gains have a savings opportunity
        st_tax = gain * (ordinary_marginal_rate + state_rate)
        lt_tax = gain * (ltcg_rate + state_rate)
        savings = st_tax - lt_tax
        out.append({
            "symbol": p.symbol,
            "quantity": p.quantity,
            "current_price": price,
            "current_value": round(proceeds, 2),
            "cost_basis": p.cost_basis,
            "unrealized_gain": round(gain, 2),
            "days_until_lt": p.days_until_lt,
            "tax_if_sold_today": round(st_tax, 2),
            "tax_if_held_to_lt": round(lt_tax, 2),
            "savings_from_holding": round(savings, 2),
        })
    return sorted(out, key=lambda r: -r["savings_from_holding"])


# ─── Pre-flight sell simulation ─────────────────────────────────────


def simulate_hypothetical_sell(
    transactions: list[dict],
    plaid_security_id: str,
    quantity: float,
    price: float,
    sell_date: Optional[datetime.date] = None,
    ordinary_marginal_rate: float = 0.22,
    ltcg_rate: float = 0.15,
    state_rate: float = 0.0425,
    wash_sale_scope: str = WASH_SCOPE_ALL_ACCOUNTS,
    account_id: Optional[int] = None,
) -> dict:
    """Run the realized-P&L calculator twice — once with the existing
    transaction history, once with a hypothetical sell appended — and
    diff the results. Lets the UI show "if you sell 10 shares of AAPL
    today, here's the tax impact + wash sale risk before you place the
    trade in your broker."

    Returns:
      {
        'baseline': {summary, tax},          # current state
        'with_hypothetical': {summary, tax}, # current state + the sell
        'delta': {
            'tax_added': float,              # additional tax owed
            'st_added': float,               # new ST gain/loss generated
            'lt_added': float,               # new LT gain/loss generated
            'wash_sale_added': float,        # disallowed loss if any
        },
        'matches': [Match dicts],            # the new sell's matches
        'wash_sale_triggered': bool,
        'wash_sale_warning': str | None,     # human-readable explanation
        'recommendation': str,               # 'proceed' | 'caution' | 'avoid'
        'recommendation_note': str,
      }

    Business logic for `recommendation`:
      - 'avoid' when the sell triggers a wash sale that disallows >$100
        of loss (the user is throwing away a deduction)
      - 'caution' when the new tax adds > $1k of liability OR when the
        position would otherwise become LT within 30 days
      - 'proceed' otherwise
    """
    if sell_date is None:
        sell_date = datetime.date.today()

    # Find the symbol label for the security so the matches read nicely.
    symbol = plaid_security_id
    earliest_buy_for_symbol = None
    for t in transactions:
        if t.get("plaid_security_id") == plaid_security_id:
            if t.get("symbol"):
                symbol = t["symbol"]
            if (t.get("type") or "").lower() == "buy":
                if earliest_buy_for_symbol is None or t["date"] < earliest_buy_for_symbol:
                    earliest_buy_for_symbol = t["date"]

    baseline = compute_realized_pnl(
        transactions, as_of=sell_date, wash_sale_scope=wash_sale_scope,
    )
    baseline_tax = estimate_tax_owed(
        baseline["summary"],
        ordinary_marginal_rate=ordinary_marginal_rate,
        ltcg_rate=ltcg_rate,
        state_rate=state_rate,
    )

    hypothetical_txn = {
        "date": sell_date,
        "type": "sell",
        "quantity": float(quantity),
        "price": float(price),
        "fees": 0.0,
        "plaid_security_id": plaid_security_id,
        "symbol": symbol,
        "plaid_investment_transaction_id": "__HYPOTHETICAL__",
        "account_id": account_id,
    }
    with_hypo = compute_realized_pnl(
        transactions + [hypothetical_txn],
        as_of=sell_date,
        wash_sale_scope=wash_sale_scope,
    )
    with_hypo_tax = estimate_tax_owed(
        with_hypo["summary"],
        ordinary_marginal_rate=ordinary_marginal_rate,
        ltcg_rate=ltcg_rate,
        state_rate=state_rate,
    )

    # Isolate the matches that came from the hypothetical sell.
    hypo_matches = [
        m for m in with_hypo["matches"]
        if m.sell_txn_id == "__HYPOTHETICAL__"
    ]
    wash_sale_added = sum(m.wash_sale_disallowed for m in hypo_matches)
    st_added = sum(
        m.gain_loss for m in hypo_matches if m.term == "ST"
    )
    lt_added = sum(
        m.gain_loss for m in hypo_matches if m.term == "LT"
    )
    tax_added = round(
        with_hypo_tax["estimated_tax_total"] - baseline_tax["estimated_tax_total"], 2
    )

    # Build human-readable wash-sale warning.
    wash_warning = None
    if wash_sale_added > 0:
        wash_warning = (
            f"This sell would trigger a wash sale: ${wash_sale_added:,.0f} of "
            f"the loss is disallowed under IRC §1091 because you bought {symbol} "
            f"within the past 30 days (or are about to). The disallowed loss "
            f"rolls into the basis of the replacement shares — you don't lose "
            f"it permanently, but you can't deduct it on this year's taxes."
        )

    # Recommendation logic.
    rec, rec_note = _classify_recommendation(
        wash_sale_added=wash_sale_added,
        tax_added=tax_added,
        hypo_matches=hypo_matches,
        sell_date=sell_date,
    )

    # Convert dataclass matches to dicts for JSON serialization.
    matches_out = []
    for m in hypo_matches:
        d = {
            "symbol": m.symbol,
            "buy_date": m.buy_date.isoformat(),
            "sell_date": m.sell_date.isoformat(),
            "quantity": m.quantity,
            "proceeds": m.proceeds,
            "basis": m.basis,
            "gain_loss": m.gain_loss,
            "holding_period_days": m.holding_period_days,
            "term": m.term,
            "wash_sale_disallowed": m.wash_sale_disallowed,
        }
        matches_out.append(d)

    return {
        "symbol": symbol,
        "quantity": float(quantity),
        "price": float(price),
        "sell_date": sell_date.isoformat(),
        "baseline": {
            "summary": baseline["summary"],
            "tax": baseline_tax,
        },
        "with_hypothetical": {
            "summary": with_hypo["summary"],
            "tax": with_hypo_tax,
        },
        "delta": {
            "tax_added": tax_added,
            "st_added": round(st_added, 2),
            "lt_added": round(lt_added, 2),
            "wash_sale_added": round(wash_sale_added, 2),
        },
        "matches": matches_out,
        "wash_sale_triggered": wash_sale_added > 0,
        "wash_sale_warning": wash_warning,
        "recommendation": rec,
        "recommendation_note": rec_note,
    }


def _classify_recommendation(
    wash_sale_added: float,
    tax_added: float,
    hypo_matches: list[Match],
    sell_date: datetime.date,
) -> tuple[str, str]:
    """Three-tier classification: proceed / caution / avoid.

    Reasoning logged in `note` so the UI can surface it.
    """
    # Worst case: throwing away a meaningful deduction.
    if wash_sale_added >= 100:
        return (
            "avoid",
            f"Sell triggers a wash sale on ${wash_sale_added:,.0f} of loss. "
            f"Wait at least 31 days after your most recent buy to preserve the "
            f"deduction this tax year."
        )

    # Check if the position is close to long-term — selling now would
    # convert what could be LTCG into ST ordinary income.
    short_term_close_to_lt = []
    for m in hypo_matches:
        if m.term == "ST" and m.gain_loss > 0:
            days_to_lt = LT_DAYS - m.holding_period_days
            if 0 < days_to_lt <= 30:
                short_term_close_to_lt.append((m, days_to_lt))
    if short_term_close_to_lt:
        soonest = min(short_term_close_to_lt, key=lambda x: x[1])
        return (
            "caution",
            f"This is a short-term gain — but the lot bought "
            f"{soonest[0].buy_date.isoformat()} converts to long-term in "
            f"{soonest[1]} day{'s' if soonest[1] != 1 else ''}. Holding that long "
            f"would tax this gain at the lower LTCG rate instead of ordinary."
        )

    # Big absolute tax hit deserves a heads-up, even if mechanically clean.
    if tax_added >= 1000:
        return (
            "caution",
            f"This sell adds ~${tax_added:,.0f} in tax owed. Consider whether "
            f"your YTD estimated tax payments cover the new liability — you "
            f"may need to send a quarterly Form 1040-ES payment to avoid an "
            f"underpayment penalty."
        )

    # Net loss case: actually a useful TLH opportunity (assuming no wash).
    total_gain_loss = sum(m.gain_loss for m in hypo_matches)
    if total_gain_loss < 0 and wash_sale_added == 0:
        return (
            "proceed",
            f"This sell realizes a ${-total_gain_loss:,.0f} loss with no wash-sale "
            f"trigger — useful for tax-loss harvesting against other gains. The "
            f"first $3k of net annual loss offsets ordinary income; excess "
            f"carries forward."
        )

    return (
        "proceed",
        "No wash-sale risk and modest tax impact. Routine sell."
    )


# ─── Aggregations: winners / losers / per-symbol ────────────────────


def aggregate_by_symbol(matches: list) -> list[dict]:
    """Roll up matches per ticker. One row per symbol with trade count,
    ST / LT realized split, and wash-sale disallowed total. Sorted by
    absolute realized $ desc so the user's eye lands on the biggest
    movers (winners or losers).
    """
    bucket: dict[str, dict] = {}
    for m in matches:
        sym = m.symbol
        if sym not in bucket:
            bucket[sym] = {
                "symbol": sym,
                "trade_count": 0,
                "shares_total": 0.0,
                "realized": 0.0,
                "st_realized": 0.0,
                "lt_realized": 0.0,
                "wash_disallowed": 0.0,
            }
        b = bucket[sym]
        b["trade_count"] += 1
        b["shares_total"] += m.quantity
        b["realized"] += m.gain_loss
        b["wash_disallowed"] += m.wash_sale_disallowed
        if m.term == "ST":
            b["st_realized"] += m.gain_loss
        else:
            b["lt_realized"] += m.gain_loss
    out = []
    for b in bucket.values():
        out.append({
            **b,
            "shares_total": round(b["shares_total"], 4),
            "realized": round(b["realized"], 2),
            "st_realized": round(b["st_realized"], 2),
            "lt_realized": round(b["lt_realized"], 2),
            "wash_disallowed": round(b["wash_disallowed"], 2),
        })
    out.sort(key=lambda r: -abs(r["realized"]))
    return out


def top_winners_losers(by_symbol: list[dict], limit: int = 5) -> dict:
    """Split a by-symbol aggregation into top winners (positive
    realized) and top losers (negative realized), each sorted by
    magnitude. Symbols with realized == 0 (closed flat) drop out."""
    winners = sorted(
        [r for r in by_symbol if r["realized"] > 0],
        key=lambda r: -r["realized"],
    )[:limit]
    losers = sorted(
        [r for r in by_symbol if r["realized"] < 0],
        key=lambda r: r["realized"],
    )[:limit]
    return {"winners": winners, "losers": losers}


# ─── Quarterly estimated tax pacing ─────────────────────────────────


# Federal quarterly estimated-tax due dates per IRS Form 1040-ES.
# Q1: Apr 15 (covers Jan-Mar), Q2: Jun 15 (covers Apr-May),
# Q3: Sep 15 (covers Jun-Aug), Q4: Jan 15 next year (covers Sep-Dec).
# The "covered period" is what we use to determine cumulative
# obligation as of each deadline.
_QUARTERS = [
    ("Q1", 4, 15, 4),    # by Apr 15: have 4/12 of year covered
    ("Q2", 6, 15, 6),    # by Jun 15: 6/12
    ("Q3", 9, 15, 9),    # by Sep 15: 9/12
    ("Q4", 1, 15, 12),   # by Jan 15 NEXT year: 12/12
]


def compute_quarterly_pacing(
    ytd_tax_owed: float,
    as_of: datetime.date,
    year: int,
) -> dict:
    """Project full-year tax owed from YTD pace and tell the user where
    they stand against IRS quarterly safe-harbor requirements.

    Strategy: linear extrapolation. If we're 100 days into the year and
    YTD tax = $5,000, projected full-year = $5000 / (100/365) ≈ $18,250.
    Quarterly obligation = projected / 4.

    For each quarter, mark whether the deadline has passed. If passed,
    cumulative obligation by that deadline = projected * (months_covered/12).
    Whether the user actually paid is unknown to Tusk Ledger — we surface
    the obligation and let them reconcile.

    The $1,000 underpayment-penalty threshold triggers if total tax
    owed at filing > $1,000 AND user hasn't met safe harbor (paid 90%
    of current-year OR 110% of prior-year through withholding +
    estimated payments). Conservative simplification: flag risk when
    projected > $1,000.
    """
    year_start = datetime.date(year, 1, 1)
    year_end = datetime.date(year, 12, 31)
    days_into_year = max(1, (as_of - year_start).days + 1)
    days_in_year = (year_end - year_start).days + 1
    fraction_elapsed = min(1.0, days_into_year / days_in_year)

    # Linear projection. Conservative: if we're early in the year and
    # tax is $0, projected stays $0 (no division explosion).
    if ytd_tax_owed <= 0 or fraction_elapsed <= 0:
        projected_full_year = 0.0
    else:
        projected_full_year = ytd_tax_owed / fraction_elapsed
    quarterly_amount = projected_full_year / 4

    # Walk the quarter list. Q4 is in the NEXT calendar year (Jan 15).
    quarters_out = []
    for label, mm, dd, months_covered in _QUARTERS:
        deadline_year = year + 1 if label == "Q4" else year
        deadline = datetime.date(deadline_year, mm, dd)
        passed = as_of >= deadline
        cumulative_obligation = round(
            projected_full_year * (months_covered / 12), 2
        )
        quarters_out.append({
            "label": label,
            "deadline": deadline.isoformat(),
            "passed": passed,
            "cumulative_obligation": cumulative_obligation,
            "incremental_obligation": round(quarterly_amount, 2),
        })

    underpayment_risk = projected_full_year > 1000.0

    return {
        "ytd_tax_owed": round(ytd_tax_owed, 2),
        "as_of": as_of.isoformat(),
        "year": year,
        "fraction_elapsed": round(fraction_elapsed, 3),
        "projected_full_year_tax": round(projected_full_year, 2),
        "quarterly_amount": round(quarterly_amount, 2),
        "quarters": quarters_out,
        "underpayment_risk": underpayment_risk,
        "underpayment_threshold": 1000.0,
        "note": (
            "Linear projection from YTD trading-tax. Doesn't account for "
            "withholding from your paycheck — if your W-2 withholding "
            "already covers 90% of current-year tax (or 110% of prior-"
            "year tax) you're in safe harbor and quarterly payments "
            "aren't required. Use this as a heads-up, not as filing advice."
        ),
    }


# ─── Form 8949 line items ───────────────────────────────────────────


def build_form_8949_rows(matches: list) -> list[dict]:
    """Convert matches into Form 8949 line items. The IRS form has
    columns:
      (a) Description of property — symbol + share count
      (b) Date acquired
      (c) Date sold
      (d) Proceeds
      (e) Cost or other basis
      (f) Code(s) — 'W' for wash sales
      (g) Amount of adjustment — disallowed loss (positive)
      (h) Gain or loss — proceeds - basis + adjustment

    Box A (short-term covered) vs Box D (long-term covered) on Form
    8949 is determined by Term. We tag it for the export so the
    accountant can split into the right form section.
    """
    rows = []
    for m in matches:
        adjustment = m.wash_sale_disallowed
        # Reported gain/loss = (proceeds - basis) + adjustment
        # For a -$200 loss with $200 wash → reported = $0
        reported_gain_loss = round(m.gain_loss + adjustment, 2)
        rows.append({
            "form_box": "A" if m.term == "ST" else "D",
            "term": m.term,
            "description": f"{m.quantity:.4f} sh {m.symbol}".rstrip("0").rstrip("."),
            "date_acquired": m.buy_date.isoformat(),
            "date_sold": m.sell_date.isoformat(),
            "proceeds": round(m.proceeds, 2),
            "basis": round(m.basis, 2),
            "code": "W" if adjustment > 0 else "",
            "adjustment": round(adjustment, 2) if adjustment > 0 else 0.0,
            "gain_loss": reported_gain_loss,
        })
    return rows


# ─── Tax-loss harvesting candidate finder ───────────────────────────


# Replacement-security lookup for the most common funds. Each entry
# pairs an "if you sell THIS, consider buying THAT" suggestion that
# maintains exposure without triggering a wash sale (different fund
# tracking a different index → not substantially identical per the
# IRS test). Conservative: only includes pairs that are widely
# regarded as not-substantially-identical. The user can override.
_REPLACEMENT_PAIRS: dict[str, str] = {
    # US broad market — different indexes, different fund families
    "VTI": "ITOT",  # Vanguard Total Mkt → iShares Core Total Mkt
    "ITOT": "VTI",
    "VOO": "SPLG",  # Vanguard S&P 500 → SPDR S&P 500 (low-fee)
    "SPLG": "VOO",
    "SPY": "IVV",   # SPY → iShares Core S&P 500 (different family)
    "IVV": "SPY",
    "FXAIX": "VOO", # Fidelity 500 → Vanguard S&P 500 ETF
    # Bonds — different aggregate indexes
    "BND": "AGG",
    "AGG": "BND",
    "VBTLX": "AGG",
    # International
    "VXUS": "IXUS",
    "IXUS": "VXUS",
    "VEA": "IDEV",
    "IDEV": "VEA",
    # Tech sector
    "QQQ": "VGT",   # Nasdaq-100 → Vanguard Information Tech
    "VGT": "QQQ",
    # Small cap
    "VB": "IJR",
    "IJR": "VB",
}


def harvest_candidates(
    open_positions: list,
    current_prices: dict,
    recent_buy_dates: dict,
    as_of: Optional[datetime.date] = None,
    ordinary_marginal_rate: float = 0.22,
    ltcg_rate: float = 0.15,
    state_rate: float = 0.0425,
) -> list[dict]:
    """Identify tax-loss-harvesting opportunities.

    A candidate is an open position currently sitting at an unrealized
    LOSS (current_value < cost_basis). The harvested loss offsets
    realized gains dollar-for-dollar plus up to $3k of ordinary income
    if it exceeds gains. ST losses are more valuable than LT (ST
    offsets at the higher ordinary rate).

    Args:
      open_positions: list of OpenPosition records (already filtered
        to taxable accounts is the caller's job — TLH only helps in
        taxable; loss in IRA/401k is wasted).
      current_prices: symbol → today's price (from Holdings table).
      recent_buy_dates: symbol → most-recent-buy date within past 30
        days (used for wash-sale safety check). None or absent if no
        recent buy.
      as_of: today's date. Defaults to today.

    Each candidate dict carries:
      - symbol, account_id, account_name (from OpenPosition)
      - quantity, cost_basis, current_value, unrealized_loss
      - days_held, term, days_until_lt
      - estimated_tax_savings (loss × applicable marginal rate)
      - wash_sale_risk: True if a buy of this symbol in past 30 days
        would self-disallow the harvested loss
      - suggested_replacement: ticker (or None)
      - notes: human-readable framing
    """
    if as_of is None:
        as_of = datetime.date.today()

    out = []
    for p in open_positions:
        price = current_prices.get(p.symbol)
        if not price or price <= 0:
            continue
        current_value = p.quantity * price
        unrealized_loss = current_value - p.cost_basis  # negative when at loss
        if unrealized_loss >= 0:
            continue  # at break-even or gain — not a harvest opportunity

        loss_amount = abs(unrealized_loss)
        # Tax savings depends on whether the loss is ST or LT. ST offsets
        # ST gains at ordinary marginal; LT offsets LT gains at LTCG rate.
        # If the user has no gains in that bucket, the loss caps at $3k
        # against ordinary income (per IRS); we don't model that here at
        # the per-candidate level since we don't know other-position
        # context — caller can adjust in aggregate.
        if p.is_long_term:
            applicable_rate = ltcg_rate + state_rate
            term = "LT"
        else:
            applicable_rate = ordinary_marginal_rate + state_rate
            term = "ST"
        estimated_tax_savings = loss_amount * applicable_rate

        wash_risk = p.symbol in recent_buy_dates and (
            (as_of - recent_buy_dates[p.symbol]).days <= WASH_WINDOW_DAYS
        )

        replacement = _REPLACEMENT_PAIRS.get(p.symbol)

        # Note framing — pick the most actionable thing to say.
        notes_parts = []
        if wash_risk:
            recent_date = recent_buy_dates[p.symbol]
            days_ago = (as_of - recent_date).days
            notes_parts.append(
                f"⚠ Wash risk: bought {p.symbol} {days_ago} days ago. "
                f"Wait {WASH_WINDOW_DAYS - days_ago + 1} more days or harvest will self-disallow."
            )
        if not p.is_long_term and 0 < p.days_until_lt <= 30:
            notes_parts.append(
                f"⏳ {p.days_until_lt} days from LT — ST harvest still available "
                f"but the window is closing."
            )
        if replacement:
            notes_parts.append(
                f"Suggested replacement: {replacement} (different fund, "
                f"not substantially identical — preserves exposure)."
            )
        else:
            notes_parts.append(
                "No automatic replacement suggested — pick a similar but "
                "not-substantially-identical alternative if you want "
                "continued exposure."
            )

        out.append({
            "symbol": p.symbol,
            "plaid_security_id": p.plaid_security_id,
            "account_id": p.account_id,
            "quantity": p.quantity,
            "cost_basis": round(p.cost_basis, 2),
            "current_value": round(current_value, 2),
            "current_price": round(price, 4),
            "unrealized_loss": round(loss_amount, 2),
            "term": term,
            "days_held": p.days_held_so_far,
            "days_until_lt": p.days_until_lt,
            "is_long_term": p.is_long_term,
            "estimated_tax_savings": round(estimated_tax_savings, 2),
            "wash_sale_risk": wash_risk,
            "suggested_replacement": replacement,
            "notes": " ".join(notes_parts),
        })
    # Sort by estimated tax savings descending — biggest opportunity
    # at the top.
    return sorted(out, key=lambda c: -c["estimated_tax_savings"])
