/* Firebase project used for publishing shared maps.
 *
 * These two values are NOT secrets. A Firebase web apiKey identifies the
 * project to Google's APIs; it grants nothing on its own. What can actually
 * be read or written is decided entirely by the security rules in
 * firestore.rules. Committing this file is normal and expected.
 *
 * Leave them blank and the app still works — Publish just reports that
 * sharing is not configured. See README "Publishing".
 */
window.ROUTE_STUDIO_FIREBASE = {
  projectId: '',
  apiKey: '',
};
