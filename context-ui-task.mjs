// Worker thread for the context page: the blocking SHA-256 and patcher work
// (spawnSync) runs here, never on the shared plugin host's event loop.
import { parentPort, workerData } from "node:worker_threads"
import { contextStatus, disableContext, unlockContext } from "./context-unlock.mjs"

const report = (value, error = false) => parentPort?.postMessage({ value, error })

try {
  const { action, env, taskId, deadline } = workerData || {}
  let value
  if (action === "status") value = contextStatus({ env, full: true })
  else if (action === "unlock") value = unlockContext({ env, taskId, deadline })
  // Restore default: switch the manifest off; managed copies are kept (no purge).
  else if (action === "disable") value = disableContext({ env, purge: false })
  else throw Object.assign(new Error("unknown context action"), { code: "invalid_action" })
  report(value)
} catch (error) {
  report({ message: String(error?.message || "context operation failed"), code: error?.code || "operation_failed" }, true)
}
