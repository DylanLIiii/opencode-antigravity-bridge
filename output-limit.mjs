// agy's own output-cap retry streams a notice as ordinary message text:
//   "\n⚠ Your previous response was cut off because it exceeded the output token limit\n"
//   "Please continue from where you left off, keeping your response shorter\n"
//   "Retries remaining: 3\n"
// and then continues the answer. The notice is agy's, not the model's, so it is
// dropped here, with the newline agy puts before it, while the rest streams on.
// Text is held only while the current line can still become the notice.
// Wording as observed by lili-luo/dsh-plugin-bundle (dsh-llm-antigravity-acp, MIT).

const HEAD = "your previous response was cut off because it exceeded the output token limit"
const TAIL = "please continue from where you left off, keeping your response shorter"
const RETRIES = "retries remaining:"

function normalize(line) {
  return line.toLowerCase()
    .replace(/^[\s⚠️]*(?:error:\s*)?/u, "")
    .replace(/\s+/g, " ")
}

const retriesLine = (text) => /^retries remaining: ?\d+\.?$/.test(text)
const stripEnd = (text) => text.replace(/[\s.]+$/, "")

export class OutputLimitFilter {
  constructor() {
    this.pending = ""
    this.midLine = false
    this.inNotice = false
    this.dropped = 0
  }

  #classify(line, complete) {
    const text = normalize(line)
    if (text.startsWith(HEAD)) return complete ? "notice" : "hold"
    if (this.inNotice) {
      if (stripEnd(text) === TAIL || retriesLine(stripEnd(text))) return complete ? "notice" : "hold"
      if (!complete && (TAIL.startsWith(text) || RETRIES.startsWith(text) || /^retries remaining: ?\d*$/.test(text))) return "hold"
    }
    if (!complete && HEAD.startsWith(text)) return "hold"
    return "emit"
  }

  push(chunk) {
    let rest = this.pending + chunk
    this.pending = ""
    let out = ""
    while (rest) {
      if (this.midLine) {
        const end = rest.indexOf("\n")
        if (end < 0) return out + rest
        out += rest.slice(0, end)
        rest = rest.slice(end)
        this.midLine = false
        continue
      }
      // At a line boundary; a leading newline ends the previous line.
      const lead = rest[0] === "\n" ? "\n" : ""
      const body = rest.slice(lead.length)
      const end = body.indexOf("\n")
      const line = end < 0 ? body : body.slice(0, end)
      const kind = this.#classify(line, end >= 0)
      if (kind === "hold") {
        this.pending = rest
        return out
      }
      if (kind === "notice") {
        this.dropped++
        this.inNotice = !retriesLine(stripEnd(normalize(line)))
        rest = body.slice(end + 1)
        continue
      }
      this.inNotice = false
      out += lead + line
      if (end < 0) {
        this.midLine = line.length > 0
        return out
      }
      rest = body.slice(end)
    }
    return out
  }

  // Releases held text at the end of a model step; a finished notice line is still dropped.
  flush() {
    const rest = this.pending
    this.pending = ""
    if (!rest) return ""
    const line = rest[0] === "\n" ? rest.slice(1) : rest
    if (this.#classify(line, true) === "notice") {
      this.dropped++
      this.inNotice = false
      return ""
    }
    this.midLine = !rest.endsWith("\n")
    return rest
  }
}
