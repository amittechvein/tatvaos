package com.techvein.tatvaos.school.smsconsent

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import androidx.core.content.ContextCompat
import androidx.core.os.BundleCompat
import com.google.android.gms.auth.api.phone.SmsRetriever
import com.google.android.gms.common.api.CommonStatusCodes
import com.google.android.gms.common.api.Status
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// Android's SMS User Consent API. While the code screen is open, the next SMS that has a code
// in it (from a sender not in the phone's contacts) makes Android ask "Allow TatvaOS School to
// read this message?". Only after the user taps Allow is that one message passed to the app.
// No SMS permission, and the SMS text needs no change (unlike the SMS Retriever API, which needs
// an app hash added to the DLT-approved message). Listening stops after 5 minutes or on stop().
class SmsConsentModule : Module() {
  private var receiver: BroadcastReceiver? = null

  override fun definition() = ModuleDefinition {
    Name("SmsConsent")
    Events("onMessage")

    Function("start") { start() }
    Function("stop") { stop() }

    OnActivityResult { _, (requestCode, resultCode, data) ->
      if (requestCode != REQUEST_CODE) return@OnActivityResult
      val message = if (resultCode == Activity.RESULT_OK) data?.getStringExtra(SmsRetriever.EXTRA_SMS_MESSAGE) else null
      if (message != null) sendEvent("onMessage", mapOf("message" to message))
    }

    OnDestroy { stop() }
  }

  private fun start() {
    val context = appContext.reactContext ?: return
    stop()
    val r = object : BroadcastReceiver() {
      override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action != SmsRetriever.SMS_RETRIEVED_ACTION) return
        val extras = intent.extras ?: return
        val status = BundleCompat.getParcelable(extras, SmsRetriever.EXTRA_STATUS, Status::class.java) ?: return
        if (status.statusCode != CommonStatusCodes.SUCCESS) return
        val consent = BundleCompat.getParcelable(extras, SmsRetriever.EXTRA_CONSENT_INTENT, Intent::class.java) ?: return
        // Only open Google Play services' own consent screen, and never pass on URI grants.
        val target = consent.resolveActivity(ctx.packageManager) ?: return
        if (target.packageName != "com.google.android.gms") return
        consent.flags = consent.flags and
          (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION).inv()
        appContext.currentActivity?.startActivityForResult(consent, REQUEST_CODE)
      }
    }
    ContextCompat.registerReceiver(
      context,
      r,
      IntentFilter(SmsRetriever.SMS_RETRIEVED_ACTION),
      SmsRetriever.SEND_PERMISSION,
      null,
      ContextCompat.RECEIVER_EXPORTED,
    )
    receiver = r
    SmsRetriever.getClient(context).startSmsUserConsent(null)
  }

  private fun stop() {
    val r = receiver ?: return
    receiver = null
    try {
      appContext.reactContext?.unregisterReceiver(r)
    } catch (_: IllegalArgumentException) {
      // already gone
    }
  }

  companion object {
    private const val REQUEST_CODE = 4127
  }
}
