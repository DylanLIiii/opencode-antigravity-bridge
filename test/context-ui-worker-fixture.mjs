// Intentionally blocks only its worker, proving that the HTTP host stays live.
import { parentPort, workerData } from "node:worker_threads"
const end = Date.now() + Number(workerData.env.TEST_WORK_MS || 250)
while (Date.now() < end) {}
parentPort.postMessage({ value: { state: "default", enabled: false, active: false } })
