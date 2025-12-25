
import sys
import importlib

def check_import(module_name):
    try:
        importlib.import_module(module_name)
        print(f"[OK] {module_name} is installed.")
        return True
    except ImportError as e:
        print(f"[FAIL] {module_name} is NOT installed. Error: {e}")
        return False

print("Checking streaming dependencies...")
deps = ["socketio", "aiohttp", "aiortc", "pyaudio", "cv2", "mss", "numpy", "av"]
results = {dep: check_import(dep) for dep in deps}

if results.get("socketio"):
    try:
        import socketio
        print(f"[INFO] python-socketio version: {getattr(socketio, '__version__', 'unknown')}")
        print(f"[INFO] socketio has Client: {hasattr(socketio, 'Client')}")
    except Exception as e:
        print(f"[FAIL] python-socketio check failed: {e}")

if results.get("aiohttp"):
    try:
        import aiohttp
        print(f"[INFO] aiohttp version: {getattr(aiohttp, '__version__', 'unknown')}")
    except Exception as e:
        print(f"[FAIL] aiohttp check failed: {e}")

if results.get("aiortc"):
    try:
        from aiortc import RTCPeerConnection, MediaStreamTrack
        print("[INFO] aiortc core classes available")
    except Exception as e:
        print(f"[FAIL] aiortc core import failed: {e}")

if results["pyaudio"]:
    try:
        import pyaudio
        p = pyaudio.PyAudio()
        count = p.get_device_count()
        print(f"[INFO] PyAudio found {count} devices.")
        for i in range(count):
            info = p.get_device_info_by_index(i)
            print(f"  Device {i}: {info['name']} (Input Channels: {info['maxInputChannels']})")
        p.terminate()
    except Exception as e:
        print(f"[FAIL] PyAudio initialization failed: {e}")

if results["cv2"]:
    try:
        import cv2
        print(f"[INFO] OpenCV version: {cv2.__version__}")
    except Exception as e:
        print(f"[FAIL] OpenCV check failed: {e}")

if results.get("av"):
    try:
        import av
        print(f"[INFO] PyAV version: {getattr(av, '__version__', 'unknown')}")
    except Exception as e:
        print(f"[FAIL] PyAV check failed: {e}")

print("Done.")
