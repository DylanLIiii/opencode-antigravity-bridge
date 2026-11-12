// agy reports its own diagnostics as ordinary agent_message_chunk text:
//   "\n⚠ Agent execution terminated due to error.\n"       -> the turn failed
//   "\n⚠ The stream was interrupted. Please continue the task you were working on.\n"
//   "\n⚠ API error (attempt N): request failed: ...: EOF"   -> internal retry noise
// They are agy's, not the model's, so they are only recognised as a standalone
// line at a line boundary. Retry notices are ignored inside code fences;
// terminal candidates are held even inside an unfinished fence. The same words
// quoted inside prose, an inline code span or a fenced block are model text and
// pass through untouched (Issue #49). Retry noise is dropped with its newline;
// a terminal banner is held until the caller checks the outcome.

const ERROR_LINE = "⚠ Agent execution terminated due to error."
const INTERRUPT_LINE = "⚠ The stream was interrupted. Please continue the task you were working on."
const API_HEAD = "⚠ API error (attempt "
const API_FULL = /^⚠ API error \(attempt \d+\): /
const API_PARTIAL = /^\d*(?:\)(?::(?: )?)?)?$/

// A vendor allowance running out is reported the same way — as an ordinary
// message chunk followed by a clean end_turn, with no error in agy's log:
//   "\n⚠ Individual quota reached. Please upgrade your subscription to
//    increase your limits. Resets in 1h40m57s.\n"
// Told as an answer, every client took it for one: the turn ended 200 with
// 28 tokens of notice and nothing routed on, so a group never fell to its
// next model while this one was spent. Held like a terminal banner instead,
// it fails the turn out of quota, and the next model of the group answers.
const QUOTA_HEADS = [
  "⚠ Individual quota reached",
  "⚠ You have exhausted your capacity",
  "⚠ Your quota will reset",
  "⚠ Quota exhausted",
  "⚠ Quota exceeded",
  "⚠ Usage limit reached",
  "⚠ You have reached your",
]
const QUOTA_FULL = /^⚠\s*(?:Individual quota reached\b|You have exhausted your capacity\b|Your quota will reset\b|Quota (?:exhausted|exceeded)\b|Usage limit (?:reached|exceeded)\b|You have reached your\b)/i
// Long enough to carry "Resets in 1h40m57s." and the upgrade hint after the
// head; a real quota line is a sentence or two, never a paragraph.
const QUOTA_MAX = 400
const QUOTA_PARTIAL = /^\d*[hm]?\d*[ms]?\d*(?:s|sec|secs|second|seconds)?\.?$/

function quotaLine(line) {
  return line.length <= QUOTA_MAX && QUOTA_FULL.test(line)
}

export class AgentNoticeFilter {
  constructor(isDiagnostic = () => false) {
    this.isDiagnostic = isDiagnostic
    this.pending = ""
    this.midLine = false
    this.dropLine = false
    this.fence = false
    this.terminal = ""
    this.failureCandidate = false
    this.dropped = 0
    // The vendor's quota notice, held as a banner: set when the turn is to be
    // failed out of quota, and the words to classify it by.
    this.quota = ""
  }

  // quotaSaid is the quota notice the turn ended on, or "" when it ended on
  // anything else. Read once the text is flushed with holdTerminal.
  get quotaSaid() { return this.quota }

  #quotaKind(line, complete) {
    if (this.fence) return ""
    if (complete) return quotaLine(line) ? "quota" : ""
    // An unfinished line that may still become the notice waits for the rest
    // of it: chunks split anywhere, including inside the reset time.
    if (quotaLine(line)) return "hold"
    if (line.length <= 48 && QUOTA_HEADS.some(head => head.startsWith(line))) return "hold"
    return ""
  }

  #classify(line, complete) {
    if (/^\s*(?:```|~~~)/.test(line)) return "fence"
    // A real upstream failure can interrupt the model inside a code fence.
    // Hold the terminal line there too; only outcome/log evidence can fail it.
    if (complete && line.trimEnd() === ERROR_LINE) return "error"
    if (!complete && (ERROR_LINE.startsWith(line) ||
      (line.length <= ERROR_LINE.length + 16 && line.trimEnd() === ERROR_LINE))) return "hold"
    if (this.fence) return "emit"
    const quota = this.#quotaKind(line, complete)
    if (quota) return quota
    if (line.startsWith("⚠") || "⚠".startsWith(line)) {
      if (complete ? line.trimEnd() === INTERRUPT_LINE : false) return "notice"
      if (API_FULL.test(line)) return "api"
      if (!complete) {
        if (ERROR_LINE.startsWith(line) || INTERRUPT_LINE.startsWith(line) || API_HEAD.startsWith(line)) return "hold"
        if (line.startsWith(API_HEAD) && line.length <= API_HEAD.length + 16 && API_PARTIAL.test(line.slice(API_HEAD.length))) return "hold"
        if (line.length <= INTERRUPT_LINE.length + 16 && (line.trimEnd() === ERROR_LINE || line.trimEnd() === INTERRUPT_LINE)) return "hold"
      }
    } else if (!complete && /^ {0,3}(?:`{1,2}|~{1,2})$/.test(line)) return "hold"
    return "emit"
  }

  push(chunk) {
    let rest = this.pending + chunk
    this.pending = ""
    let out = ""
    if (this.terminal && rest) { out = this.isDiagnostic() ? "" : this.terminal; this.terminal = ""; this.failureCandidate = !rest.trim() }
    while (rest) {
      if (this.dropLine || this.midLine) {
        if (!this.dropLine && rest.trim()) this.failureCandidate = false
        const end = rest.indexOf("\n")
        if (end < 0) return out + (this.dropLine ? "" : rest)
        if (!this.dropLine) out += rest.slice(0, end)
        rest = rest.slice(end)
        this.dropLine = false
        this.midLine = false
        continue
      }
      const lead = rest[0] === "\n" ? "\n" : ""
      const body = rest.slice(lead.length)
      const end = body.indexOf("\n")
      const line = end < 0 ? body : body.slice(0, end)
      const kind = this.#classify(line, end >= 0)
      if (kind === "hold") {
        this.pending = rest
        return out
      }
      if (kind === "error") {
        this.terminal = lead + line + "\n"
        this.failureCandidate = true
        rest = body.slice(end + 1)
        if (rest) { out += this.isDiagnostic() ? "" : this.terminal; this.terminal = ""; this.failureCandidate = !rest.trim(); continue }
        return out
      }
      if (kind === "notice" || kind === "api") {
        this.dropped++
        this.failureCandidate = true
        if (end < 0) { this.dropLine = true; return out }
        rest = body.slice(end + 1)
        continue
      }
      if (kind === "quota") {
        // Held, never shown: a spent allowance is not the model's answer. The
        // turn is failed out of quota once nothing else came after it.
        this.quota = line.trim()
        this.failureCandidate = true
        if (end < 0) return out
        rest = body.slice(end + 1)
        continue
      }
      if (kind === "fence") this.fence = !this.fence
      out += lead + line
      if (line.trim()) { this.failureCandidate = false; this.quota = "" }
      if (end < 0) {
        this.midLine = line.length > 0
        return out
      }
      rest = body.slice(end)
    }
    return out
  }

  // Releases held text at the end of a model step. A banner held without its
  // final newline is still a banner when it is the whole remaining line.
  flush({ holdTerminal = false } = {}) {
    this.dropLine = false
    const rest = this.pending
    this.pending = ""
    if (!rest) {
      if (holdTerminal) return ""
      const terminal = this.terminal
      this.terminal = ""
      return terminal
    }
    const line = rest[0] === "\n" ? rest.slice(1) : rest
    if (line.trimEnd() === ERROR_LINE) { this.failureCandidate = true; this.terminal += rest; return holdTerminal ? "" : this.flush() }
    if (!this.fence) {
      if (quotaLine(line.trimEnd())) { this.quota = line.trim(); this.failureCandidate = true; return "" }
      if (line.trimEnd() === INTERRUPT_LINE || API_FULL.test(line)) { this.dropped++; this.failureCandidate = true; return "" }
    }
    this.midLine = !rest.endsWith("\n")
    return rest
  }
}
