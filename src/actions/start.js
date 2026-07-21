import { isUp } from '../palworld.js';
import { sanitizeErrorMessage } from '../utils/security.js';
import { withLockResult, startAndReport, announceAction } from './shared.js';

/**
 * Starts the server under the shared lock. Mirrors the /palstart core behaviour
 * and returns the same messages so the Discord command is unchanged. onProgress
 * surfaces the coarse "checking for updates" line from the update-on-start check.
 * @param {{ actor?: string, originChannelId?: string, onProgress?: (message: string) => (void|Promise<void>) }} [options]
 *   actor is used only for the announcement; originChannelId is the channel the
 *   command was run in, which suppresses the announcement per shouldAnnounce
 * @returns {Promise<{success: boolean, message: string, embedTitle?: string}>}
 */
export async function doStart({ actor, originChannelId, onProgress } = {}) {
  return withLockResult(async () => {
    const up = await isUp();
    if (up) {
      return { success: true, message: 'Server is already **UP**.', embedTitle: 'Server Status' };
    }

    try {
      // startAndReport owns launch + monitor state + the update-warning suffix.
      const message = await startAndReport('Server started successfully!', onProgress);

      // Announce the successful, explicitly-requested start
      await announceAction(actor, 'started', originChannelId);

      return { success: true, message, embedTitle: 'Server Started' };
    } catch (e) {
      // Provide specific error feedback to help with troubleshooting
      const sanitizedMessage = sanitizeErrorMessage(e);
      return { success: false, message: `Start failed: \`${sanitizedMessage}\`` };
    }
  });
}
