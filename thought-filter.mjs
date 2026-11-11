// agy 1.5.5 runs its own conversation-title summarizer inside the same ACP
// session as the user's turn and reports that model's reasoning as ordinary
// `agent_thought_chunk` updates (issue #39). One turn can carry dozens of them,
// each several kilobytes, all echoing the summarizer prompt, so clients that key
// a reasoning item on its opening characters collapse the whole turn into one
// repeated step and inflate the transcript.
//
// Observed vs. assumed:
//
// - Observed (#39, agy 1.5.5): every leaked chunk began with the same
//   "Thinking Process: 1. **Analyze the Request:** ..." prompt echo, 13 and 49
//   chunks in two turns, one distinct 80-character prefix per turn.
// - Assumed: agy's ACP stream may carry a native source discriminator that the
//   bridge does not read yet. Nothing in this repository or in agy 1.5.5's
//   `session/update` handling demonstrates one, and the leak could not be
//   reproduced against a live account here, so this module does not claim the
//   wire lacks a marker. It is a content fallback used only because no native
//   signal is known to be available.
//
// The fallback is deliberately narrow. A thought is treated as the summarizer's
// when all of these hold:
//
//   1. it opens with the summarizer's "Thinking Process:" header,
//   2. within EARLY_WINDOW characters it names the summarizer's own first step
//      (analyze the request) or its goal (summarize the provided thoughts), and
//   3. within SUMMARY_WINDOW characters it also states the output constraint
//      (first person / maximum N words / a length line).
//
// A primary-turn thought that merely talks about summarizing has no summarizer
// header, so it is forwarded unchanged. The same holds for a thought about the
// user's own summary task, and for reasoning that opens with the header words
// but then analyses the user's request in its own voice.
//
// When the signature matched, the rest of that echoed prompt may still arrive in
// later chunks: ACP reports no thought-block boundary, and one prompt echo can be
// split mid-structure. That case is covered by a continuation region, bounded by
// ECHO_REGION_MAX characters, which suppresses a following chunk only when it
// both opens with one of that prompt's field labels *and* restates one of its own
// distinguishing phrases. Two limits follow, and neither is hidden: a chunk that
// continues the echo mid-word has no field label and is forwarded, and a summary
// call whose continuation carries no distinguishing phrase is only partly
// suppressed. In exchange, no new "Thinking Process:" thought and no reasoning
// that merely opens with a field label is ever dropped by the region. The
// guarantee is therefore "the echoed prompt and its recognisable continuation are
// suppressed", not "any split is filtered"; a native ACP marker, if one exists,
// would replace this heuristic entirely.
//
// Detection stays per chunk otherwise, so streaming semantics are preserved: text
// is held only while the signature is still decidable, which is bounded by
// EARLY_WINDOW and SUMMARY_WINDOW and applies only to reasoning that literally
// starts with the header. The caller keeps its own progress clock on every
// non-empty chunk, so suppressed output still counts as agy activity.

const HEADER_TEXT = "thinking process:"
// Where the summarizer prompt puts its first step, measured from the header:
// "Thinking Process: 1. **Analyze the Request:** ..." in every observed leak.
const EARLY_WINDOW = 64
// Enough for the header plus the prompt's goal and length instructions.
const SUMMARY_WINDOW = 512
const ANALYSIS = /analy[sz]e the request/i
const GOAL = /summari[sz]e the provided thoughts/i
const CONSTRAINT = /first[- ]person|maximum\s+\d+\s+words|length:\s*(?:maximum|max)/i
// A chunk that continues the echoed prompt after the signature matched: a bold
// field label from that prompt's vocabulary *and* one of the summary's own
// distinguishing statements. A field label alone (a real thought opening with
// "**Goal:**") is forwarded, so continuation suppression cannot drop reasoning.
const ECHO_FIELD = new RegExp("^\\s*(?:[*\\-•]\\s*)?(?:\\d+[.)]\\s*)?\\*\\*(?:" + [
  "goal", "perspective", "length", "format", "output", "title", "style", "tone",
  "constraints?", "steps?", "analy[sz]e", "analysis", "draft", "refine", "review", "notes?",
].join("|") + ")\\b", "i")
// Phrases only the summarizer's prompt states. A continuation chunk carrying one
// of these is the rest of the echo; a field label alone is not enough, because a
// real thought may open with "**Goal:**".
const ECHO_STATEMENT = new RegExp([GOAL.source, CONSTRAINT.source].join("|"), "i")
// Bounds the residual echo suppression. #39 observed leaked chunks of 2.8K-12K
// characters, so this covers one such chunk while a misjudged region still ends.
const ECHO_REGION_MAX = 16384

export class SummaryThoughtFilter {
  constructor(options = {}) {
    this.window = options.window ?? SUMMARY_WINDOW
    this.early = options.earlyWindow ?? EARLY_WINDOW
    this.regionMax = options.regionMax ?? ECHO_REGION_MAX
    this.pending = ""
    this.echo = null
    this.droppedChunks = 0
    this.droppedChars = 0
  }

  // "matched" once the header is present, "possibly" while the text could still
  // grow into it, "no" otherwise.
  #header(text) {
    const rest = text.slice(/^\s*/.exec(text)[0].length)
    if (rest.length >= HEADER_TEXT.length) {
      return rest.slice(0, HEADER_TEXT.length).toLowerCase() === HEADER_TEXT ? "matched" : "no"
    }
    return HEADER_TEXT.startsWith(rest.toLowerCase()) ? "possibly" : "no"
  }

  #drop(text) {
    this.droppedChunks++
    this.droppedChars += text.length
    return ""
  }

  #dropEcho(text) {
    this.echo = { remaining: this.regionMax - text.length }
    return this.#drop(text)
  }

  #looksLikeSummary(text) {
    const head = text.slice(0, this.window)
    return GOAL.test(head) && CONSTRAINT.test(head)
  }

  #push(text) {
    const joined = this.pending + text
    this.pending = ""
    const header = this.#header(joined)
    if (header === "no") return joined
    const early = joined.slice(0, this.early)
    if (!ANALYSIS.test(early) && !GOAL.test(early)) {
      // The summarizer always names its own step or goal immediately after the
      // header. Past this point only primary reasoning can look like this.
      if (joined.length >= this.early) return joined
      this.pending = joined
      return ""
    }
    if (header === "matched" && this.#looksLikeSummary(joined)) return this.#dropEcho(joined)
    // Full prompt echo not seen yet: hold while it could still arrive. A full
    // window without the goal and constraint is the primary turn's reasoning.
    if (joined.length >= this.window) return joined
    this.pending = joined
    return ""
  }

  // Returns the text to forward, which is empty while a chunk is held back or
  // when the chunk belongs to the summarizer's echoed prompt.
  push(text) {
    if (!text) return ""
    if (this.echo) {
      if (ECHO_FIELD.test(text) && ECHO_STATEMENT.test(text) && this.echo.remaining >= text.length) {
        this.echo.remaining -= text.length
        return this.#drop(text)
      }
      // A new summarizer call still has to match the full signature; a new
      // "Thinking Process:" thought is classified exactly like the first one.
      // Anything else ends the region and is classified normally.
      this.echo = null
    }
    return this.#push(text)
  }

  // Releases held text so a decision that never became decidable can never
  // swallow output, and ends the echo region at a stream boundary. Called when
  // answer text or a tool call resumes the turn, when the buffered stream is
  // reset, and when the turn ends.
  flush() {
    const text = this.pending
    this.pending = ""
    this.echo = null
    return text
  }

  get dropped() {
    return this.droppedChunks
  }
}
