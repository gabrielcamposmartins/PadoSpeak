package dev.padospeak.android

import android.graphics.Color

/** Cores CSS que a página manda (#rgb, #rrggbb, #rrggbbaa, rgb()/rgba()) para as barras do sistema. */
object CssColor {
    fun parse(css: String?): Int? {
        val s = css?.trim()?.lowercase() ?: return null
        try {
            if (s.startsWith("#")) {
                val h = s.drop(1)
                return when (h.length) {
                    3 -> Color.rgb(dup(h[0]), dup(h[1]), dup(h[2]))
                    6 -> Color.rgb(h.substring(0, 2).toInt(16), h.substring(2, 4).toInt(16), h.substring(4, 6).toInt(16))
                    8 -> Color.rgb(h.substring(0, 2).toInt(16), h.substring(2, 4).toInt(16), h.substring(4, 6).toInt(16))
                    else -> null
                }
            }
            val m = Regex("""^rgba?\(([^)]*)\)$""").find(s) ?: return null
            val parts = m.groupValues[1].split(Regex("""[,\s/]+""")).filter { it.isNotEmpty() }
            if (parts.size < 3) return null
            val c = parts.take(3).map { p ->
                if (p.endsWith("%")) (p.dropLast(1).toFloat() * 2.55f).toInt() else p.toFloat().toInt()
            }.map { it.coerceIn(0, 255) }
            return Color.rgb(c[0], c[1], c[2])
        } catch (_: Exception) {
            return null
        }
    }

    private fun dup(c: Char) = "$c$c".toInt(16)

    /** Cor clara o bastante para pedir ícones escuros nas barras. */
    fun isLight(color: Int): Boolean {
        val l = (0.2126 * Color.red(color) + 0.7152 * Color.green(color) + 0.0722 * Color.blue(color)) / 255
        return l > 0.6
    }
}
