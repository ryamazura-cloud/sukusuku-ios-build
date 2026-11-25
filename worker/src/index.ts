import { createApp, type Bindings } from './app.ts'
import { Firestore } from './firestore.ts'
import { FirebaseVerifier, GoogleAccess } from './google.ts'

const verifier = new FirebaseVerifier()
let previous: Bindings | undefined
let firestore: Firestore
export default createApp({
  uid: (header, project) => verifier.uid(header, project),
  store: env => {
    if (!previous || previous.FIREBASE_PROJECT_ID !== env.FIREBASE_PROJECT_ID ||
        previous.GOOGLE_PRIVATE_KEY !== env.GOOGLE_PRIVATE_KEY ||
        previous.GOOGLE_CLIENT_EMAIL !== env.GOOGLE_CLIENT_EMAIL) {
      previous = env
      firestore = new Firestore(env.FIREBASE_PROJECT_ID, new GoogleAccess({
        email: env.GOOGLE_CLIENT_EMAIL, key: env.GOOGLE_PRIVATE_KEY,
      }))
    }
    return firestore
  },
})
