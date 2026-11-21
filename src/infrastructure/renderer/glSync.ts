/**
 * Resolves true once the GPU has passed `sync`, or false after `timeoutMs`. Browsers set
 * MAX_CLIENT_WAIT_TIMEOUT_WEBGL to 0, so a blocking clientWaitSync fails; this polls instead.
 * Deletes `sync` either way.
 */
export async function waitForSync(
  gl: WebGL2RenderingContext,
  sync: WebGLSync,
  timeoutMs: number
): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  try {
    for (;;) {
      if (gl.getSyncParameter(sync, gl.SYNC_STATUS) === gl.SIGNALED) return true;
      if (gl.isContextLost() || performance.now() >= deadline) return false;
      // The status only changes between tasks, so yield to the event loop.
      await new Promise((resolve) => setTimeout(resolve, 4));
    }
  } finally {
    gl.deleteSync(sync);
  }
}
