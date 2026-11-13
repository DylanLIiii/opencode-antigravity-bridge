// This static page has no API access. Navigate its own sandboxed frame to the
// service, using Magpie's token proxy in web and the configured port in native.
async function openContextPage() {
  const message = document.getElementById("message")
  try {
    await magpie.ready
    const options = await magpie.options.get()
    const configured = Number(options?.contextPort)
    const port = Number.isInteger(configured) && configured > 0 && configured <= 65535 ? configured : 47821
    const address = new URL(magpie.service || `http://127.0.0.1:${port}/`)
    address.hash = new URLSearchParams({ theme: JSON.stringify(magpie.theme || {}) }).toString()
    location.replace(address.href)
  } catch {
    message.textContent = /^zh/i.test(magpie?.theme?.lang || "")
      ? "无法打开上下文设置。请重试，或使用 agy-bridge context status / unlock / disable。"
      : "Context settings could not open. Retry, or use agy-bridge context status / unlock / disable."
    document.getElementById("retry").hidden = false
  }
}
document.getElementById("retry").addEventListener("click", openContextPage)
openContextPage()
