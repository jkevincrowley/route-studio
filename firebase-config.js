/* Firebase project used for publishing shared maps.
 *
 * Left blank on purpose. On GitHub Pages this file is rewritten at deploy time
 * from the repository variables FIREBASE_PROJECT_ID and FIREBASE_API_KEY, so a
 * copy of this repo never carries anyone else's project. See README,
 * "Sharing (optional)".
 *
 * Blank is fine: everything except share links works without it.
 *
 * Neither value is a secret. A Firebase web apiKey identifies a project to
 * Google and grants nothing by itself; what can be read or written is decided
 * entirely by firestore.rules.
 */
window.ROUTE_STUDIO_FIREBASE = {
  projectId: '',
  apiKey: '',
};
