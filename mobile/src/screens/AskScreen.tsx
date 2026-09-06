/**
 * Ask — Ask Tusk on the phone.
 *
 * Two brains, one chat:
 *   1. The laptop (POST /api/mobile/ask): the full retrieve-then-narrate
 *      assistant — 38 grounded retrievers, the local model narrating only
 *      figures it was handed. Used whenever the laptop is reachable.
 *   2. This phone (ask/intent.ts + ask/local.ts): a small deterministic
 *      parser over the SQLite mirror for the store-aisle questions —
 *      spend by category/merchant/period, balances, net worth, bills,
 *      budget, biggest purchases. Used only when the laptop can't be
 *      reached, and every such answer is labelled "answered on this phone".
 *
 * Read-only, insight-only, like the laptop's Ask panel: there is no action
 * path here and nothing is written back. History is kept in memory for the
 * session only (a chat about your finances shouldn't outlive the app).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { flagAnswer } from '../ask/flags';
import { parseLocalIntent } from '../ask/intent';
import { answerLocally, type LocalAnswer } from '../ask/local';
import Chip from '../components/Chip';
import Screen from '../components/Screen';
import { askTusk, AuthError, fetchBriefing, NetworkError } from '../sync/api';
import type { AskTurnWire } from '../sync/types';
import { colors, layout, radius, space, type } from '../theme';

type Origin = 'laptop' | 'phone' | 'system';

interface Message {
  id: string;
  who: 'you' | 'tusk';
  text: string;
  origin?: Origin;
  /** Provenance line under a Tusk answer. */
  basis?: string;
  rows?: LocalAnswer['rows'];
  pending?: boolean;
  /** The question this reply answers (for the review log). */
  q?: string;
  /** Retriever / parser intent and assistant provenance, when known. */
  intent?: string | null;
  source?: string | null;
  /** 👍/👎 given on this reply. */
  rated?: 'up' | 'down';
}

const SUGGESTIONS = [
  'How much have I spent this month?',
  'What did I spend on groceries last month?',
  'What bills are due?',
  "What's my net worth?",
  'Biggest purchases this month',
  'How am I doing on my budget?',
];

let nextId = 1;
const mid = () => String(nextId++);

function sourceLabel(source: string, grounded: boolean): string {
  switch (source) {
    case 'ollama': return grounded ? 'Answered on your laptop · grounded in your data' : 'Answered on your laptop';
    case 'retrieval': return 'Answered on your laptop · exact figures from your data';
    case 'guarded': return 'Answered on your laptop · model output replaced with exact figures';
    case 'refusal': return 'Your laptop found nothing in the data that answers this';
    default: return 'Answered on your laptop';
  }
}

export default function AskScreen() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const listRef = useRef<FlatList<Message>>(null);

  // Greeting: the laptop's proactive briefing when reachable, else a plain
  // hello that says what the phone can answer on its own.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const b = await fetchBriefing();
        if (cancelled) return;
        if (b?.briefing) {
          setMessages([{ id: mid(), who: 'tusk', text: b.briefing, origin: 'laptop' }]);
          return;
        }
      } catch {
        // fall through to the offline greeting
      }
      if (!cancelled) {
        setMessages([{
          id: mid(), who: 'tusk', origin: 'system',
          text: "I can't reach your laptop right now, so I'll answer what I can from this phone's copy: spending by category or store, balances, net worth, bills and budget.",
        }]);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const historyFor = (msgs: Message[]): AskTurnWire[] =>
    msgs.filter((m) => !m.pending && m.origin !== 'system').slice(-6).map((m) => ({ who: m.who, text: m.text }));

  const send = useCallback(async (raw?: string) => {
    const question = (raw ?? text).trim();
    if (!question || busy) return;
    setText('');
    setBusy(true);
    const you: Message = { id: mid(), who: 'you', text: question };
    const pendingId = mid();
    setMessages((m) => [...m, you, { id: pendingId, who: 'tusk', text: '', pending: true }]);
    const history = historyFor(messages);

    const finish = (reply: Omit<Message, 'id' | 'who'>) => {
      setMessages((m) => m.map((x) => (x.id === pendingId ? { id: pendingId, who: 'tusk', ...reply } : x)));
      setBusy(false);
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50);
    };

    const intent = parseLocalIntent(question);
    const answerOnPhone = async (why: string) => {
      const a = await answerLocally(intent!);
      finish({
        text: a.answer,
        origin: 'phone',
        basis: a.basis.startsWith('Answered') ? a.basis : `Answered on this phone${why} · ${a.basis}`,
        rows: a.rows,
        q: question,
        intent: intent!.kind,
        source: null,
      });
    };
    try {
      const r = await askTusk(question, history);
      // The laptop found nothing grounded, but the phone's own parser knows this one → use it
      // rather than showing a refusal (the laptop's catalog and the phone's overlap but aren't equal).
      if (!r.found && intent && intent.kind !== 'help') {
        try { await answerOnPhone(''); return; } catch { /* fall through to the laptop's text */ }
      }
      finish({
        text: r.answer || "I didn't get an answer back.",
        origin: 'laptop',
        basis: sourceLabel(r.source, r.grounded),
        q: question,
        intent: r.intent,
        source: r.source,
      });
      return;
    } catch (e) {
      const offline = e instanceof NetworkError || e instanceof AuthError;
      if (intent) {
        try {
          await answerOnPhone(offline ? ' (laptop unreachable)' : '');
          return;
        } catch {
          // fall through
        }
      }
      finish({
        origin: 'system',
        text: offline
          ? "I can't reach your laptop, and that one needs it. Try again on your home Wi-Fi — or ask about spending, balances, net worth, bills or budget, which I can answer here."
          : e instanceof Error ? e.message : 'Something went wrong asking your laptop.',
      });
    }
  }, [text, busy, messages]);

  /**
   * 👍/👎 → the review log. A 👎 offers an optional one-line note ("wrong store",
   * "that's last month's number") because the note is usually the most useful
   * part of the flag when it's reviewed weeks later.
   */
  const rate = useCallback((item: Message, rating: 'up' | 'down') => {
    const submit = async (comment?: string) => {
      setMessages((m) => m.map((x) => (x.id === item.id ? { ...x, rated: rating } : x)));
      try {
        await flagAnswer({
          question: item.q ?? '',
          answer: item.text,
          rating,
          origin: item.origin === 'phone' ? 'phone' : 'laptop',
          intent: item.intent ?? null,
          source: item.source ?? null,
          comment: comment?.trim() || null,
        });
      } catch {
        // queued or dropped silently — never interrupt the conversation
      }
    };
    if (rating === 'up' || Platform.OS !== 'ios') {
      submit();
      return;
    }
    Alert.prompt(
      'What was off?',
      'Optional — a few words help when this gets reviewed later.',
      [
        { text: 'Skip', onPress: () => submit(), style: 'cancel' },
        { text: 'Flag', onPress: (note?: string) => submit(note) },
      ],
      'plain-text',
    );
  }, []);

  const renderItem = ({ item }: { item: Message }) => {
    const mine = item.who === 'you';
    const ratable = !mine && !item.pending && item.origin !== 'system' && !!item.q;
    return (
      <View style={[styles.bubbleRow, mine && { justifyContent: 'flex-end' }]}>
        <View style={[styles.bubble, mine ? styles.bubbleYou : styles.bubbleTusk, item.origin === 'system' && styles.bubbleSystem]}>
          {item.pending ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space(2) }}>
              <ActivityIndicator size="small" color={colors.textMuted} />
              <Text style={type.small}>Asking your laptop…</Text>
            </View>
          ) : (
            <>
              <Text style={[type.body, mine && { color: colors.onAccent }]}>{item.text}</Text>
              {item.rows && item.rows.length > 0 && (
                <View style={styles.rows}>
                  {item.rows.map((r, i) => (
                    <View key={`${r.label}-${i}`} style={styles.row}>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={[type.small, { color: colors.text }]} numberOfLines={1}>{r.label}</Text>
                        {r.sub ? <Text style={type.small} numberOfLines={1}>{r.sub}</Text> : null}
                      </View>
                      <Text style={[type.small, styles.tabular, { color: colors.text }]}>{r.value}</Text>
                    </View>
                  ))}
                </View>
              )}
              {item.basis && (
                <Text style={[type.small, { marginTop: space(1.5), color: item.origin === 'phone' ? colors.warning : colors.textFaint, fontSize: 11 }]}>
                  {item.basis}
                </Text>
              )}
              {ratable && (
                <View style={styles.rateRow}>
                  {item.rated ? (
                    <Text style={[type.small, { fontSize: 11, color: colors.textFaint }]}>
                      {item.rated === 'down' ? 'Flagged for review' : 'Thanks'}
                    </Text>
                  ) : (
                    <>
                      <Pressable onPress={() => rate(item, 'up')} hitSlop={8} accessibilityRole="button" accessibilityLabel="Good answer" style={styles.rateBtn}>
                        <Text style={styles.rateGlyph}>👍</Text>
                      </Pressable>
                      <Pressable onPress={() => rate(item, 'down')} hitSlop={8} accessibilityRole="button" accessibilityLabel="Wrong or unhelpful — flag for review" style={styles.rateBtn}>
                        <Text style={styles.rateGlyph}>👎</Text>
                      </Pressable>
                    </>
                  )}
                </View>
              )}
            </>
          )}
        </View>
      </View>
    );
  };

  const showSuggestions = messages.filter((m) => m.who === 'you').length === 0;

  return (
    <Screen title="Ask Tusk" scroll={false} banner={false}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}>
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(m) => m.id}
          renderItem={renderItem}
          contentContainerStyle={styles.list}
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
          keyboardShouldPersistTaps="handled"
          ListFooterComponent={
            showSuggestions ? (
              <View style={styles.suggestions}>
                {SUGGESTIONS.map((s) => (
                  <Chip key={s} label={s} small onPress={() => send(s)} />
                ))}
              </View>
            ) : null
          }
        />
        <View style={styles.inputRow}>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder="Ask about your money…"
            placeholderTextColor={colors.textFaint}
            style={styles.input}
            returnKeyType="send"
            onSubmitEditing={() => send()}
            editable={!busy}
            multiline
            maxLength={600}
            accessibilityLabel="Question"
          />
          <Pressable
            onPress={() => send()}
            disabled={busy || !text.trim()}
            style={({ pressed }) => [styles.sendBtn, (busy || !text.trim()) && { opacity: 0.4 }, pressed && { opacity: 0.7 }]}
            accessibilityRole="button"
            accessibilityLabel="Send">
            <Text style={styles.sendArrow}>↑</Text>
          </Pressable>
        </View>
        <Text style={styles.footnote}>Insight only — nothing here changes your data.</Text>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: {
    paddingHorizontal: layout.screenPad,
    paddingTop: space(2),
    paddingBottom: space(3),
    gap: space(2.5),
  },
  bubbleRow: { flexDirection: 'row' },
  bubble: {
    maxWidth: '88%',
    paddingHorizontal: space(3.5),
    paddingVertical: space(2.5),
    borderRadius: radius.lg,
  },
  bubbleTusk: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderTopLeftRadius: radius.sm,
  },
  bubbleYou: {
    backgroundColor: colors.accent,
    borderTopRightRadius: radius.sm,
  },
  bubbleSystem: {
    backgroundColor: colors.surfaceElevated,
    borderStyle: 'dashed',
  },
  rows: {
    marginTop: space(2),
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingTop: space(1.5),
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(3),
    marginTop: space(1.5),
  },
  tabular: { fontVariant: ['tabular-nums'] },
  rateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(3),
    marginTop: space(2),
  },
  rateBtn: {
    minWidth: 32,
    minHeight: 28,
    alignItems: 'center',
    justifyContent: 'center',
    opacity: 0.7,
  },
  rateGlyph: { fontSize: 14 },
  suggestions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space(2),
    marginTop: space(2),
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: space(2),
    paddingHorizontal: layout.screenPad,
    paddingTop: space(2),
  },
  input: {
    flex: 1,
    ...type.body,
    maxHeight: 110,
    paddingHorizontal: space(3.5),
    paddingVertical: space(2.5),
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  sendBtn: {
    width: layout.minTouch,
    height: layout.minTouch,
    borderRadius: layout.minTouch / 2,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendArrow: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.onAccent,
  },
  footnote: {
    ...type.small,
    color: colors.textFaint,
    fontSize: 11,
    textAlign: 'center',
    paddingVertical: space(2),
  },
});
