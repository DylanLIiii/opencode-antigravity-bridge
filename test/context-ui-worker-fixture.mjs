// Intentionally blocks only its worker, proving that the HTTP host stays live.
import { parentPort, workerData } from "node:worker_threads"
import fs from "node:fs"
import path from "node:path"
if (workerData.env.TEST_STAGING_READY) {
  const staging = fs.mkdtempSync(path.join(workerData.env.AGY_BRIDGE_CONTEXT_DIR, `.unlock-${workerData.taskId}-`))
  fs.writeFileSync(path.join(staging, "agy"), "synthetic staging copy")
  fs.writeFileSync(workerData.env.TEST_STAGING_READY, "ready")
}
const end = Date.now() + Number(workerData.env.TEST_WORK_MS || 250)
while (Date.now() < end) {}
parentPort.postMessage({ value: { state: "default", enabled: false, active: false } })
