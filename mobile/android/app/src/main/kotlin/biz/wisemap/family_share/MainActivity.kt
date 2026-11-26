package biz.wisemap.family_share

import android.app.AlertDialog
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
import android.graphics.Color
import android.view.Gravity
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.MediaController
import android.widget.VideoView
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.io.File
import java.io.IOException

class MainActivity : FlutterActivity() {
    private var activePlayback: AlertDialog? = null
    private var activeVideo: VideoView? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel("sukusuku_album", "アルバムのお知らせ", NotificationManager.IMPORTANCE_HIGH)
            )
        }
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "biz.wisemap.family_share/video")
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "temporaryDirectory" -> result.success(cacheDir.absolutePath)
                    "open" -> openVideo(call.arguments as? String, result)
                    else -> result.notImplemented()
                }
            }
    }

    private fun openVideo(path: String?, result: MethodChannel.Result) {
        val file = try {
            path?.let { File(it).canonicalFile }?.takeIf {
                it.path.startsWith(cacheDir.canonicalPath + File.separator) && it.isFile
            }
        } catch (_: IOException) {
            null
        }
        if (file == null || activePlayback != null || isFinishing) {
            result.error("video_unavailable", "Video is unavailable", null)
            return
        }

        val video = VideoView(this)
        val controller = MediaController(this)
        val frame = FrameLayout(this).apply {
            setBackgroundColor(Color.BLACK)
            minimumHeight = (220 * resources.displayMetrics.density).toInt()
            addView(video, FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT, Gravity.CENTER
            ))
        }
        val dialog = AlertDialog.Builder(this)
            .setTitle("動画")
            .setView(frame)
            .setPositiveButton("閉じる", null)
            .create()
        var failed = false
        activePlayback = dialog
        activeVideo = video
        video.setMediaController(controller)
        controller.setAnchorView(video)
        video.setOnPreparedListener {
            video.seekTo(1)
            controller.show(3000)
        }
        video.setOnErrorListener { _, _, _ ->
            failed = true
            dialog.dismiss()
            true
        }
        dialog.setOnDismissListener {
            controller.hide()
            video.stopPlayback()
            activePlayback = null
            activeVideo = null
            if (failed) result.error("video_failed", "Video could not be played", null)
            else result.success(null)
        }
        dialog.show()
        video.setVideoPath(file.path)
    }

    override fun onPause() {
        activeVideo?.pause()
        super.onPause()
    }

    override fun onDestroy() {
        activePlayback?.dismiss()
        super.onDestroy()
    }
}
