// Writes through the setup log helper once the test has closed this process's stdout pipe, so the write hits EPIPE.
import { log } from "../../src/setup/environment.ts"

setTimeout(() => {
  for (let line = 0; line < 3; line++) log(`setup output ${line}`)
}, 100)
