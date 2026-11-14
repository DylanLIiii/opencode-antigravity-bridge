// agy reports its own diagnostics as ordinary agent_message_chunk text:
//   "\n⚠ Agent execution terminated due to error.\n"       -> the turn failed
//   "\n⚠ The stream was interrupted. Please continue the task you were working on.\n"
//   "\n⚠ API error (attempt N): request failed: ...: EOF"   -> internal retry noise
// Network/credits terminal notices are also failure evidence without a log.
// Invalid-output notices describe an internal retry and are dropped.
// They are agy's, not the model's, so they are only recognised as a standalone
// line at a line boundary. Retry notices are ignored inside code fences;
// terminal candidates are held even inside an unfinished fence. The same words
// quoted inside prose, an inline code span or a fenced block are model text and
// pass through untouched (Issue #49). Retry noise is dropped with its newline;
// a terminal banner is held until the caller checks the outcome.

const ERROR_LINE = "⚠ Agent execution terminated due to error."
const NETWORK_LINE = "⚠ There was a network issue connecting to the server, please try again."
const CREDITS_LINE = "⚠ Your AI credits balance is too low to continue."
const INVALID_LINE = "⚠ Model produced invalid output."
const TERMINAL_LINES = [NETWORK_LINE, CREDITS_LINE]
const INTERRUPT_LINE = "⚠ The stream was interrupted. Please continue the task you were working on."
const API_HEAD = "⚠ API error (attempt "
const API_FULL = /^⚠ API error \(attempt \d+\): /
const API_PARTIAL = /^\d*(?:\)(?::(?: )?)?)?$/

export class AgentNoticeFilter {
  constructor(isDiagnostic = () => false) {
    this.isDiagnostic = isDiagnostic
    this.pending = ""
    this.midLine = false
    this.dropLine = false
    this.captureApi = false
    this.fence = false
    this.terminal = ""
    this.failureCandidate = false
    this.dropped = 0
    this.terminalDetail = ""
    this.apiDetail = ""
  }

  #classify(line, complete) {
    if (/^\s*(?:```|~~~)/.test(line)) return "fence"
    // A real upstream failure can interrupt the model inside a code fence.
    // Hold the terminal line there too; only outcome/log evidence can fail it.
    if (complete && line.trimEnd() === ERROR_LINE) return "error"
    if (!complete && (ERROR_LINE.startsWith(line) ||
      (line.length <= ERROR_LINE.length + 16 && line.trimEnd() === ERROR_LINE))) return "hold"
    if (this.fence) return "emit"
    if (complete && TERMINAL_LINES.includes(line.trimEnd())) return "terminal"
    if (!complete && TERMINAL_LINES.some(value => value.startsWith(line) ||
      (line.length <= value.length + 16 && line.trimEnd() === value))) return "hold"
    if (line.startsWith("⚠") || "⚠".startsWith(line)) {
      if (complete ? [INTERRUPT_LINE, INVALID_LINE].includes(line.trimEnd()) : false) return "notice"
      if (API_FULL.test(line)) return "api"
      if (!complete) {
        if (ERROR_LINE.startsWith(line) || INTERRUPT_LINE.startsWith(line) || INVALID_LINE.startsWith(line) || API_HEAD.startsWith(line)) return "hold"
        if (line.startsWith(API_HEAD) && line.length <= API_HEAD.length + 16 && API_PARTIAL.test(line.slice(API_HEAD.length))) return "hold"
        if (line.length <= INTERRUPT_LINE.length + 16 && (line.trimEnd() === ERROR_LINE || line.trimEnd() === INTERRUPT_LINE || line.trimEnd() === INVALID_LINE)) return "hold"
      }
    } else if (!complete && /^ {0,3}(?:`{1,2}|~{1,2})$/.test(line)) return "hold"
    return "emit"
  }

  push(chunk) {
    let rest = this.pending + chunk
    this.pending = ""
    let out = ""
    if (this.terminal && rest) { out = this.isDiagnostic() || this.apiDetail || this.terminalDetail ? "" : this.terminal; this.terminal = "" }
    while (rest) {
      if (this.dropLine || this.midLine) {
        if (this.captureApi) this.apiDetail = (this.apiDetail + rest.split("\n", 1)[0]).slice(0, 2000)
        const end = rest.indexOf("\n")
        if (!this.dropLine && (end < 0 ? rest : rest.slice(0, end)).trim()) this.#recovered()
        if (end < 0) return out + (this.dropLine ? "" : rest)
        if (!this.dropLine) out += rest.slice(0, end)
        rest = rest.slice(end)
        this.dropLine = false
        this.captureApi = false
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
      if (kind === "terminal") {
        this.terminalDetail = line.trimEnd()
        this.failureCandidate = true
        this.dropped++
        rest = body.slice(end + 1)
        continue
      }
      if (kind === "error") {
        this.terminal = lead + line + "\n"
        this.failureCandidate = true
        rest = body.slice(end + 1)
        if (rest) { out += this.isDiagnostic() || this.apiDetail || this.terminalDetail ? "" : this.terminal; this.terminal = ""; continue }
        return out
      }
      if (kind === "notice" || kind === "api") {
        if (kind === "api") this.apiDetail = line.slice(0, 2000)
        this.dropped++
        this.failureCandidate = true
        if (end < 0) { this.dropLine = true; this.captureApi = kind === "api"; return out }
        rest = body.slice(end + 1)
        continue
      }
      if (kind === "fence") this.fence = !this.fence
      out += lead + line
      if (line.trim()) this.#recovered()
      if (end < 0) {
        this.midLine = line.length > 0
        return out
      }
      rest = body.slice(end)
    }
    return out
  }

  #recovered() {
    this.failureCandidate = false
    this.terminalDetail = ""
    this.apiDetail = ""
  }

  // Releases held text at the end of a model step. A banner held without its
  // final newline is still a banner when it is the whole remaining line.
  flush({ holdTerminal = false } = {}) {
    this.dropLine = false
    this.captureApi = false
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
      if (TERMINAL_LINES.includes(line.trimEnd())) { this.failureCandidate = true; this.terminalDetail = line.trimEnd(); this.dropped++; return "" }
      if (API_FULL.test(line)) this.apiDetail = line.slice(0, 2000)
      if ([INTERRUPT_LINE, INVALID_LINE].includes(line.trimEnd()) || API_FULL.test(line)) { this.dropped++; this.failureCandidate = true; return "" }
    }
    this.midLine = !rest.endsWith("\n")
    if (rest.trim()) this.#recovered()
    return rest
  }
}
