import datetime
from sqlalchemy import Column, String, Float, Date, DateTime, Integer, ForeignKey
from sqlalchemy.orm import relationship
from app.database import Base


class ManualAsset(Base):
    """A user-tracked asset that doesn't come from a Plaid sync.

    Primarily homes (the original use case: pair a Zestimate with a Wells
    Fargo mortgage so Net Worth shows both sides). The schema is generic
    enough to also hold a vehicle, collectible, business equity stake,
    crypto held in cold storage, etc.

    Net worth aggregation treats these as assets: their `current_value`
    adds straight to `total_assets`. They do NOT contribute transactions,
    spending, or cash-flow rollups — they only matter for the balance
    sheet.

    `plaid_mortgage_account_id` lets a home asset be paired with the
    account holding its mortgage. UI uses this to show "valued $354k vs.
    $245k owed → $109k equity" in one place; the FK is informational and
    can be left null.
    """
    __tablename__ = "manual_assets"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String, nullable=False)
    # Which side of the balance sheet this entry belongs on:
    #   'asset'     → adds to total_assets     (home, car, business equity, crypto, cash in mattress)
    #   'liability' → adds to total_liabilities (student loan, personal loan to friend, tax bill owed)
    # Stored as a string rather than an enum so adding more sides in the
    # future (e.g. contingent, pending) doesn't require a migration.
    side = Column(String, nullable=False, default="asset")
    type = Column(String, nullable=False)        # real_estate | vehicle | student_loan | personal_loan | other
    current_value = Column(Float, nullable=False, default=0.0)

    # When the user last set the value. Drives "X days stale" UI nudge.
    value_as_of = Column(Date, nullable=False, default=datetime.date.today)
    notes = Column(String, nullable=True)

    # Optional address — auto-filled from a paired mortgage if present.
    # Used to seed the Zillow / Redfin lookup buttons.
    address_street = Column(String, nullable=True)
    address_city = Column(String, nullable=True)
    address_region = Column(String, nullable=True)
    address_postal_code = Column(String, nullable=True)
    address_country = Column(String, nullable=True)

    # Pair this asset with the mortgage account for the same property.
    # SET NULL on account delete so the asset survives a mortgage unlink.
    plaid_mortgage_account_id = Column(
        Integer, ForeignKey("accounts.id", ondelete="SET NULL"), nullable=True, index=True
    )
    paired_account = relationship("Account")

    # Pair this asset with a manual liability (e.g., a vehicle paired with
    # an auto-loan liability that lives in this same table). Used when the
    # loan ISN'T a Plaid account — common for auto loans where the lender's
    # Plaid integration is flaky or unsupported. Nullable; SET NULL on
    # liability delete so the asset survives.
    paired_manual_liability_id = Column(
        Integer, ForeignKey("manual_assets.id", ondelete="SET NULL"),
        nullable=True, index=True,
    )
    paired_liability = relationship(
        "ManualAsset",
        foreign_keys=[paired_manual_liability_id],
        remote_side="ManualAsset.id",
    )

    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.datetime.utcnow, onupdate=datetime.datetime.utcnow)
