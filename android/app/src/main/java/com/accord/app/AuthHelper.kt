package com.accord.app

import android.app.Activity
import android.content.Context
import android.content.Intent
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import com.google.android.gms.auth.api.signin.GoogleSignIn
import com.google.android.gms.auth.api.signin.GoogleSignInClient
import com.google.android.gms.auth.api.signin.GoogleSignInOptions
import com.google.android.gms.common.api.ApiException
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.FirebaseUser
import com.google.firebase.auth.GoogleAuthProvider

/**
 * Wraps Google Sign-In + Firebase auth for native use. Sign-in goes through
 * the system account picker, then we exchange the Google ID token for a
 * Firebase credential. The token is also handed to the WebView bridge so the
 * embedded JS auth state stays in sync.
 *
 * Caller usage:
 *   private lateinit var auth: AuthHelper
 *   override fun onCreate(...) {
 *     auth = AuthHelper(this) { user, err -> ... }
 *   }
 *   // then: auth.signIn(forceAccountPicker = true)
 */
class AuthHelper(
    private val activity: ComponentActivity,
    /** Fires after every sign-in attempt (success or error). */
    private val onResult: (user: FirebaseUser?, idToken: String?, error: String?) -> Unit,
) {
    private val firebaseAuth: FirebaseAuth = FirebaseAuth.getInstance()
    private val client: GoogleSignInClient

    private val launcher: ActivityResultLauncher<Intent> =
        activity.registerForActivityResult(
            ActivityResultContracts.StartActivityForResult()
        ) { result ->
            if (result.resultCode != Activity.RESULT_OK || result.data == null) {
                onResult(null, null, "Sign-in cancelled")
                return@registerForActivityResult
            }
            handleSignInResult(result.data!!)
        }

    init {
        // The "web client ID" (oauth_client where client_type == 3 in google-services.json)
        // is what Firebase expects when exchanging the Google ID token. The native
        // (type 1) entry is what binds the picker to this package + SHA-1.
        val webClientId = activity.getString(R.string.default_web_client_id)
        val options = GoogleSignInOptions.Builder(GoogleSignInOptions.DEFAULT_SIGN_IN)
            .requestIdToken(webClientId)
            .requestEmail()
            .requestProfile()
            .build()
        client = GoogleSignIn.getClient(activity, options)
    }

    val currentUser: FirebaseUser? get() = firebaseAuth.currentUser

    fun signIn(forceAccountPicker: Boolean = true) {
        // Always force the picker for explicit "Switch account" semantics; silent
        // sign-in would otherwise re-use the cached Google account.
        val start = {
            launcher.launch(client.signInIntent)
        }
        if (forceAccountPicker) {
            client.signOut().addOnCompleteListener { start() }
        } else {
            start()
        }
    }

    /** Sign out of both Firebase and Google Sign-In so the next prompt re-asks. */
    fun signOut(onDone: () -> Unit = {}) {
        firebaseAuth.signOut()
        client.signOut().addOnCompleteListener { onDone() }
    }

    /**
     * Silent sign-in: returns a fresh Google ID token for the cached account
     * without any UI. Used by GateActivity to bootstrap the WebView's Firebase
     * JS state — JS calls signInWithCredential(idToken) so the embedded site
     * sees the same user that's signed in natively.
     *
     * Returns null if there is no cached account, the silent flow fails (e.g.
     * after a Play services version change), or Firebase Auth has no user.
     */
    fun silentSignIn(onDone: (idToken: String?) -> Unit) {
        if (firebaseAuth.currentUser == null) { onDone(null); return }
        val task = client.silentSignIn()
        if (task.isComplete) {
            onDone(if (task.isSuccessful) task.result?.idToken else null)
            return
        }
        task.addOnCompleteListener { t ->
            onDone(if (t.isSuccessful) t.result?.idToken else null)
        }
    }

    private fun handleSignInResult(data: Intent) {
        val task = GoogleSignIn.getSignedInAccountFromIntent(data)
        try {
            val account = task.getResult(ApiException::class.java)
            val idToken = account?.idToken
            if (idToken.isNullOrEmpty()) {
                onResult(null, null, "Missing Google ID token")
                return
            }
            val credential = GoogleAuthProvider.getCredential(idToken, null)
            firebaseAuth.signInWithCredential(credential)
                .addOnSuccessListener { result ->
                    onResult(result.user, idToken, null)
                }
                .addOnFailureListener { e ->
                    onResult(null, null, e.localizedMessage ?: "Firebase sign-in failed")
                }
        } catch (e: ApiException) {
            // Status 12501 is the user backing out of the picker — quiet error.
            val msg = when (e.statusCode) {
                12501 -> "Sign-in cancelled"
                else  -> "Sign-in failed (${e.statusCode})"
            }
            onResult(null, null, msg)
        }
    }

    companion object {
        fun firebaseUser(): FirebaseUser? = FirebaseAuth.getInstance().currentUser

        /** Convenience for places that have a Context but no AuthHelper instance. */
        fun isSignedIn(@Suppress("UNUSED_PARAMETER") ctx: Context): Boolean =
            FirebaseAuth.getInstance().currentUser != null
    }
}
