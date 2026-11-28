package biz.wisemap.family_share

import android.app.Activity
import android.app.AlertDialog
import android.content.ContentValues
import android.content.Intent
import android.net.Uri
import android.os.Environment
import android.provider.MediaStore
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
import android.media.MediaMetadataRetriever
import androidx.exifinterface.media.ExifInterface
import android.graphics.Color
import android.view.Gravity
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.MediaController
import android.widget.VideoView
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugin.common.StandardMethodCodec
import java.io.File
import java.io.IOException
import kotlin.concurrent.thread

class MainActivity : FlutterActivity() {
    private data class PendingSave(
        val bytes: ByteArray,
        val result: MethodChannel.Result
    )

    private var pendingSave: PendingSave? = null
    private val saveRequest = 9124
    private var activePlayback: AlertDialog? = null
    private var activeVideo: VideoView? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel("sukusuku_album", "アルバムのお知らせ", NotificationManager.IMPORTANCE_HIGH)
            )
        }
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "biz.wisemap.family_share/app")
            .setMethodCallHandler { call, result ->
                if (call.method != "buildNumber") {
                    result.notImplemented()
                    return@setMethodCallHandler
                }
                val info = packageManager.getPackageInfo(packageName, 0)
                @Suppress("DEPRECATION")
                val version = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    info.longVersionCode
                } else {
                    info.versionCode.toLong()
                }
                result.success(version)
            }
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "biz.wisemap.family_share/metadata",
            StandardMethodCodec.INSTANCE, flutterEngine.dartExecutor.makeBackgroundTaskQueue())
            .setMethodCallHandler { call, result ->
                if (call.method != "captureDate") {
                    result.notImplemented()
                    return@setMethodCallHandler
                }
                val path = call.argument<String>("path")
                val date = path?.let { readCaptureDate(it, call.argument<Boolean>("video") == true) }
                result.success(date)
            }
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "biz.wisemap.family_share/video")
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "temporaryDirectory" -> result.success(cacheDir.absolutePath)
                    "open" -> openVideo(call.arguments as? String, result)
                    "save" -> saveMedia(call.argument<ByteArray>("bytes"), call.argument<Boolean>("video") == true, result)
                    else -> result.notImplemented()
                }
            }
    }

    private fun saveMedia(bytes: ByteArray?, video: Boolean, result: MethodChannel.Result) {
        if (bytes == null || bytes.isEmpty() || bytes.size > 16 * 1024 * 1024 || pendingSave != null) {
            result.error("save_failed", "Media is unavailable", null)
            return
        }
        val mime = if (video) "video/mp4" else "image/jpeg"
        val extension = if (video) "mp4" else "jpg"
        val name = "sukusuku-${System.currentTimeMillis()}.$extension"
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = mime
                putExtra(Intent.EXTRA_TITLE, name)
            }
            pendingSave = PendingSave(bytes, result)
            try {
                @Suppress("DEPRECATION")
                startActivityForResult(intent, saveRequest)
            } catch (_: Exception) {
                pendingSave = null
                result.error("save_failed", "No document picker", null)
            }
            return
        }
        val folder = if (video) Environment.DIRECTORY_MOVIES else Environment.DIRECTORY_PICTURES
        val collection = if (video) MediaStore.Video.Media.EXTERNAL_CONTENT_URI else MediaStore.Images.Media.EXTERNAL_CONTENT_URI
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, name)
            put(MediaStore.MediaColumns.MIME_TYPE, mime)
            put(MediaStore.MediaColumns.RELATIVE_PATH, "$folder/Sukusuku")
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        writeMedia(result) {
            val uri = contentResolver.insert(collection, values) ?: throw IOException("Media insert failed")
            try {
                writeTo(uri, bytes)
                val update = ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }
                if (contentResolver.update(uri, update, null, null) == 0) throw IOException("Media finalize failed")
            } catch (failure: Exception) {
                runCatching { contentResolver.delete(uri, null, null) }
                throw failure
            }
        }
    }

    private fun writeMedia(result: MethodChannel.Result, write: () -> Unit) {
        thread {
            val saved = runCatching(write).isSuccess
            runOnUiThread {
                if (saved) result.success(true)
                else result.error("save_failed", "Media could not be written", null)
            }
        }
    }

    private fun writeTo(uri: Uri, bytes: ByteArray) {
        val output = contentResolver.openOutputStream(uri) ?: throw IOException("Media output unavailable")
        output.use { it.write(bytes) }
    }

    @Deprecated("Used for the document picker on Android 9 and earlier")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != saveRequest) return
        val save = pendingSave ?: return
        pendingSave = null
        val uri = data?.data
        if (resultCode != Activity.RESULT_OK || uri == null) {
            save.result.success(false)
            return
        }
        writeMedia(save.result) { writeTo(uri, save.bytes) }
    }

    private fun readCaptureDate(path: String, video: Boolean): String? = runCatching {
        if (video) {
            val metadata = MediaMetadataRetriever()
            try {
                metadata.setDataSource(path)
                metadata.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DATE)
            } finally {
                metadata.release()
            }
        } else {
            ExifInterface(path).getAttribute(ExifInterface.TAG_DATETIME_ORIGINAL)
        }
    }.getOrNull()

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
