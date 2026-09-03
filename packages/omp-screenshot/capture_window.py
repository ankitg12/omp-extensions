"""Capture a window (even when occluded by the terminal) for the OMP /screenshot command.

Solves the self-screenshot problem: on a single laptop screen the OMP/WezTerm window
owns the display, so a full-screen grab photographs the agent itself. We instead read a
target window's own pixels.

Engine: Windows.Graphics.Capture (WGC) via the `windows-capture` library is the primary
path — the latest Windows API, it captures a window's DWM surface regardless of what is
on top of it (including GPU/hardware-composited content). Win32 PrintWindow is a zero-dep
fallback if WGC is unavailable or returns nothing.

Usage:
  capture_window.py --out PATH [--title SUBSTR]   capture window (title match, else topmost non-terminal)
  capture_window.py --out PATH --title self       capture the terminal/OMP window itself (debugging)
  capture_window.py --list                        list candidate windows in z-order

Behavior of --out with no --title:
  multi-monitor -> full grab of the primary monitor (original extension behavior)
  single screen -> topmost non-terminal window (the one behind the terminal)

Prints one line: "OK <desc>" on success, "ERR <reason>" on failure. Exit 0 on success.
"""
import argparse
import os
import sys
import threading
import time
from ctypes import windll

import win32con
import win32gui
import win32process
import win32ui
from PIL import Image

# Terminals that host OMP itself — excluded from normal capture, targeted by `--title self`.
TERMINAL_EXES = {"wezterm-gui.exe", "windowsterminal.exe", "conhost.exe", "openconsole.exe"}
SELF_KEYWORDS = {"self", "omp", "terminal", "term"}
PW_RENDERFULLCONTENT = 2  # PrintWindow flag: include GPU/DWM-composited content


def _proc_exe(hwnd: int) -> str:
    try:
        _, pid = win32process.GetWindowThreadProcessId(hwnd)
        h = windll.kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            return ""
        try:
            from ctypes import create_unicode_buffer, byref, c_uint
            buf = create_unicode_buffer(512)
            size = c_uint(512)
            if windll.kernel32.QueryFullProcessImageNameW(h, 0, buf, byref(size)):
                return buf.value.rsplit("\\", 1)[-1].lower()
        finally:
            windll.kernel32.CloseHandle(h)
    except Exception:
        pass
    return ""


def candidate_windows():
    """Visible, non-minimized, titled top-level windows in z-order (top first).

    Returns list of (hwnd, title, is_terminal).
    """
    out = []

    def cb(hwnd, _):
        if not win32gui.IsWindowVisible(hwnd):
            return
        if win32gui.IsIconic(hwnd):  # minimized -> capture yields black
            return
        title = win32gui.GetWindowText(hwnd).strip()
        if not title:
            return
        out.append((hwnd, title, _proc_exe(hwnd) in TERMINAL_EXES))

    win32gui.EnumWindows(cb, None)
    return out


def resolve_target(title_substr: str, want_self: bool = False):
    """Return (hwnd, exact_title) for the requested window, or None."""
    wins = candidate_windows()
    if want_self:
        for hwnd, title, is_term in wins:
            if is_term:
                return hwnd, title  # topmost terminal = the OMP host window
        return None
    if title_substr:
        needle = title_substr.lower()
        for hwnd, title, is_term in wins:
            if not is_term and needle in title.lower():
                return hwnd, title
        return None
    for hwnd, title, is_term in wins:
        if not is_term:
            return hwnd, title  # topmost non-terminal = what was behind the terminal
    return None


def _nonblack(path: str) -> bool:
    try:
        from PIL import ImageStat
        st = ImageStat.Stat(Image.open(path).convert("RGB"))
        return sum(st.mean) >= 6
    except Exception:
        return True  # if we can't measure, assume valid


def capture_wgc(title: str, out_path: str, timeout_s: float = 8.0) -> bool:
    """Capture a window by exact title via Windows.Graphics.Capture. Returns True on success."""
    try:
        from windows_capture import WindowsCapture, Frame, InternalCaptureControl
    except Exception:
        return False

    done = {"ok": False}
    try:
        cap = WindowsCapture(
            cursor_capture=False,
            draw_border=False,  # Win11 21H2+; the yellow capture border is suppressed
            monitor_index=None,
            window_name=title,
        )
    except Exception:
        return False

    @cap.event
    def on_frame_arrived(frame: "Frame", ctl: "InternalCaptureControl"):
        try:
            frame.save_as_image(out_path)
            done["ok"] = True
        finally:
            ctl.stop()

    @cap.event
    def on_closed():
        pass

    # Run the WGC message loop on a daemon thread so a frameless window can't hang us.
    # WGC raises (on the thread) if the exact title is stale — e.g. a terminal's live
    # spinner mutates between resolve and lookup; swallow it and fall back to PrintWindow.
    def _pump():
        try:
            cap.start()
        except Exception:
            pass
    t = threading.Thread(target=_pump, daemon=True)
    t.start()
    deadline = time.time() + timeout_s
    while time.time() < deadline and not done["ok"]:
        if not t.is_alive():
            break  # WGC pump exited (found nothing) -> fail fast to fallback
        time.sleep(0.05)
    return done["ok"] and os.path.exists(out_path) and _nonblack(out_path)


def capture_printwindow(hwnd: int, out_path: str) -> bool:
    """Fallback: capture a window's pixels via Win32 PrintWindow. Returns True on success."""
    left, top, right, bot = win32gui.GetWindowRect(hwnd)
    w, h = right - left, bot - top
    if w <= 0 or h <= 0:
        return False

    hwnd_dc = win32gui.GetWindowDC(hwnd)
    mfc_dc = win32ui.CreateDCFromHandle(hwnd_dc)
    save_dc = mfc_dc.CreateCompatibleDC()
    bmp = win32ui.CreateBitmap()
    bmp.CreateCompatibleBitmap(mfc_dc, w, h)
    save_dc.SelectObject(bmp)
    try:
        windll.user32.PrintWindow(hwnd, save_dc.GetSafeHdc(), PW_RENDERFULLCONTENT)
        info = bmp.GetInfo()
        bits = bmp.GetBitmapBits(True)
        img = Image.frombuffer("RGB", (info["bmWidth"], info["bmHeight"]), bits, "raw", "BGRX", 0, 1)
        img.save(out_path)
    finally:
        win32gui.DeleteObject(bmp.GetHandle())
        save_dc.DeleteDC()
        mfc_dc.DeleteDC()
        win32gui.ReleaseDC(hwnd, hwnd_dc)
    return os.path.exists(out_path) and _nonblack(out_path)


def capture_window(hwnd: int, title: str, out_path: str) -> str:
    """WGC first (occlusion/GPU-safe), PrintWindow fallback. Returns the engine used."""
    if capture_wgc(title, out_path):
        return "wgc"
    if capture_printwindow(hwnd, out_path):
        return "printwindow"
    raise RuntimeError("both WGC and PrintWindow failed")


def physical_monitor_count() -> int:
    """Number of real displays (mss.monitors[0] is the virtual 'all screens' union)."""
    try:
        import mss
        with mss.MSS() as s:
            return max(0, len(s.monitors) - 1)
    except Exception:
        return 1


def grab_primary(out_path: str) -> None:
    """Full grab of the primary monitor (the pre-existing default behavior)."""
    from PIL import ImageGrab
    ImageGrab.grab().save(out_path)


def main() -> int:
    # Window titles carry arbitrary Unicode (e.g. a zero-width space in "Microsoft<U+200B> Edge");
    # Windows stdout defaults to cp1252 and would crash on print. Force UTF-8.
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    try:
        windll.shcore.SetProcessDpiAwareness(2)  # per-monitor v2: real pixels
    except Exception:
        try:
            windll.user32.SetProcessDPIAware()
        except Exception:
            pass

    ap = argparse.ArgumentParser()
    ap.add_argument("--out")
    ap.add_argument("--title", default="")
    ap.add_argument("--list", action="store_true")
    args = ap.parse_args()

    if args.list:
        for hwnd, title, is_term in candidate_windows():
            print(f"{hex(hwnd)} {'[term] ' if is_term else ''}{title}")
        return 0

    if not args.out:
        print("ERR --out required")
        return 2

    want_self = args.title.strip().lower() in SELF_KEYWORDS

    # No title on a multi-monitor setup: keep the original full primary-monitor grab.
    if not args.title and physical_monitor_count() > 1:
        try:
            grab_primary(args.out)
        except Exception as e:
            print(f"ERR {e}")
            return 1
        print("OK primary monitor")
        return 0

    target = resolve_target("" if want_self else args.title, want_self=want_self)
    if target is None:
        if want_self:
            print("ERR no terminal/OMP window found")
        elif args.title:
            print(f"ERR no visible window matches title: {args.title}")
        else:
            print("ERR no capturable non-terminal window found")
        return 3

    hwnd, title = target
    try:
        engine = capture_window(hwnd, title, args.out)
    except Exception as e:
        print(f"ERR {e}")
        return 1
    print(f"OK {title} [{engine}]")
    return 0


if __name__ == "__main__":
    rc = main()
    # WGC may leave a daemon capture thread alive; exit hard so the CLI returns promptly.
    sys.stdout.flush()
    os._exit(rc)
