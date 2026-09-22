package com.accord.app

import android.os.Bundle
import android.widget.Button
import android.widget.ImageButton
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.widget.SwitchCompat

class SettingsActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_settings)

        findViewById<ImageButton>(R.id.backBtn).setOnClickListener { finish() }

        val openInAppSwitch = findViewById<SwitchCompat>(R.id.openInAppSwitch)
        openInAppSwitch.isChecked = Prefs.openFormsInApp(this)
        openInAppSwitch.setOnCheckedChangeListener { _, isChecked ->
            Prefs.setOpenFormsInApp(this, isChecked)
        }

        findViewById<TextView>(R.id.versionLabel).text =
            getString(R.string.current_version, BuildConfig.VERSION_NAME)
        findViewById<Button>(R.id.checkUpdatesBtn).setOnClickListener {
            UpdateUi.check(this, force = true)
        }
    }
}
