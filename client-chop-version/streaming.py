"""
Streaming module
Handles screen, audio, and camera streaming functionality
"""

import queue
import threading
import time
import base64
from logging_utils import log_message
from dependencies import MSS_AVAILABLE, NUMPY_AVAILABLE, CV2_AVAILABLE, PYAUDIO_AVAILABLE, PIL_AVAILABLE, AIORTC_AVAILABLE
from config import TARGET_FPS, CAPTURE_QUEUE_SIZE, ENCODE_QUEUE_SIZE, AUDIO_CAPTURE_QUEUE_SIZE, AUDIO_ENCODE_QUEUE_SIZE, TARGET_CAMERA_FPS, CHUNK, CHANNELS, RATE, FORMAT

# Global state variables
STREAMING_ENABLED = False
STREAM_THREADS = []
capture_queue = None
encode_queue = None

AUDIO_STREAMING_ENABLED = False
AUDIO_STREAM_THREADS = []
audio_capture_queue = None
audio_encode_queue = None

CAMERA_STREAMING_ENABLED = False
CAMERA_STREAM_THREADS = []
camera_capture_queue = None
camera_encode_queue = None

# WebRTC global state
WEBRTC_ACTIVE = False
WEBRTC_PC = None
WEBRTC_LOOP = None
WEBRTC_THREAD = None
WEBRTC_AGENT_ID = None
WEBRTC_TRACKS = {}

def _ensure_webrtc_loop():
    global WEBRTC_LOOP
    import asyncio
    if WEBRTC_LOOP is None:
        WEBRTC_LOOP = asyncio.new_event_loop()
        t = threading.Thread(target=WEBRTC_LOOP.run_forever, daemon=True)
        t.start()
    return WEBRTC_LOOP

def _shutdown_webrtc_loop():
    global WEBRTC_LOOP
    if WEBRTC_LOOP is not None:
        try:
            WEBRTC_LOOP.call_soon_threadsafe(WEBRTC_LOOP.stop)
        except Exception:
            pass
        WEBRTC_LOOP = None

def _create_screen_track(target_fps=30):
    if not MSS_AVAILABLE or not NUMPY_AVAILABLE:
        return None
    try:
        import numpy as np
        import mss
        from aiortc import VideoStreamTrack
        from av import VideoFrame
    except Exception:
        return None

    class ScreenTrack(VideoStreamTrack):
        kind = "video"
        def __init__(self, fps=30):
            super().__init__()
            self._fps = fps
            self._frame_time = 1.0 / max(1, fps)
            self._last = 0.0
            self._sct = mss.mss()
            self._monitor = self._sct.monitors[1]
            self._width = self._monitor['width']
            self._height = self._monitor['height']
            if self._width > 1280:
                scale = 1280 / self._width
                self._width = int(self._width * scale)
                self._height = int(self._height * scale)

        async def recv(self):
            now = time.time()
            delay = self._frame_time - (now - self._last)
            if delay > 0:
                await self._sleep(delay)
            self._last = time.time()
            img = self._sct.grab(self._monitor)
            arr = np.array(img)
            if arr.shape[1] != self._width or arr.shape[0] != self._height:
                try:
                    import cv2
                    arr = cv2.resize(arr, (self._width, self._height), interpolation=cv2.INTER_AREA)
                except Exception:
                    pass
            if arr.shape[2] == 4:
                arr = arr[:, :, :3]
            frame = VideoFrame.from_ndarray(arr, format="bgr24")
            pts, time_base = await self.next_timestamp()
            frame.pts = pts
            frame.time_base = time_base
            return frame

    return ScreenTrack(target_fps)

def _create_camera_track(target_fps=30):
    if not CV2_AVAILABLE:
        return None
    try:
        import cv2
        from aiortc import VideoStreamTrack
        from av import VideoFrame
    except Exception:
        return None

    class CameraTrack(VideoStreamTrack):
        kind = "video"
        def __init__(self, fps=30):
            super().__init__()
            self._fps = fps
            self._frame_time = 1.0 / max(1, fps)
            self._last = 0.0
            self._cap = cv2.VideoCapture(0)
            try:
                self._cap.set(cv2.CAP_PROP_FPS, fps)
                self._cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
                self._cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
            except Exception:
                pass

        async def recv(self):
            now = time.time()
            delay = self._frame_time - (now - self._last)
            if delay > 0:
                await self._sleep(delay)
            self._last = time.time()
            ret, frame = self._cap.read()
            if not ret:
                await self._sleep(0.01)
                ret, frame = self._cap.read()
            if not ret:
                # produce a blank frame to keep pipeline alive
                import numpy as np
                frame = np.zeros((480, 640, 3), dtype=np.uint8)
            vf = VideoFrame.from_ndarray(frame, format="bgr24")
            pts, time_base = await self.next_timestamp()
            vf.pts = pts
            vf.time_base = time_base
            return vf

    return CameraTrack(target_fps)

def _create_audio_track():
    if not AIORTC_AVAILABLE:
        return None
    try:
        from aiortc import MediaStreamTrack
        import av
        import numpy as np
        import pyaudio
    except Exception:
        return None

    class MicrophoneTrack(MediaStreamTrack):
        kind = "audio"
        def __init__(self):
            super().__init__()
            self._pa = pyaudio.PyAudio()
            self._stream = self._pa.open(format=FORMAT, channels=CHANNELS, rate=RATE, input=True, frames_per_buffer=CHUNK)

        async def recv(self):
            data = self._stream.read(CHUNK, exception_on_overflow=False)
            samples = np.frombuffer(data, dtype=np.int16)
            frame = av.AudioFrame.from_ndarray(samples, format='s16', layout='mono' if CHANNELS == 1 else 'stereo')
            frame.sample_rate = RATE
            return frame

    return MicrophoneTrack()

def get_or_create_agent_id():
    """Get or create a unique agent ID."""
    import uuid
    import os
    
    # Try to load existing ID
    id_file = os.path.expanduser("~/.agent_id")
    if os.path.exists(id_file):
        try:
            with open(id_file, 'r') as f:
                return f.read().strip()
        except:
            pass
    
    # Create new ID
    agent_id = str(uuid.uuid4())
    try:
        with open(id_file, 'w') as f:
            f.write(agent_id)
    except:
        pass
    
    return agent_id

def stream_screen(agent_id):
    """Legacy screen streaming function - redirects to new implementation."""
    return stream_screen_h264_socketio(agent_id)

def start_streaming(agent_id, mode='auto'):
    """Start screen streaming with modern pipeline."""
    global STREAMING_ENABLED, STREAM_THREADS, capture_queue, encode_queue
    
    if STREAMING_ENABLED:
        log_message("Screen streaming already active")
        return True
    
    if (mode == 'webrtc' or mode == 'auto') and AIORTC_AVAILABLE:
        ok = start_webrtc_streaming(agent_id, kind='screen')
        if ok:
            log_message("Screen streaming started via WebRTC")
            return True
        if mode == 'auto':
            log_message("WebRTC start failed, falling back to Socket.IO")
        else:
            return False
    
    if not MSS_AVAILABLE or not NUMPY_AVAILABLE or not CV2_AVAILABLE:
        log_message("Required modules not available for screen streaming", "error")
        return False
    
    log_message("Starting screen streaming...")
    
    # Initialize queues
    capture_queue = queue.Queue(maxsize=CAPTURE_QUEUE_SIZE)
    encode_queue = queue.Queue(maxsize=ENCODE_QUEUE_SIZE)
    
    STREAMING_ENABLED = True
    
    # Start worker threads
    threads = [
        threading.Thread(target=screen_capture_worker, args=(agent_id,), daemon=True),
        threading.Thread(target=screen_encode_worker, args=(agent_id,), daemon=True),
        threading.Thread(target=screen_send_worker, args=(agent_id,), daemon=True),
    ]
    
    for thread in threads:
        thread.start()
        STREAM_THREADS.append(thread)
    
    log_message("Screen streaming started successfully")
    return True

def stop_streaming():
    """Stop screen streaming."""
    global STREAMING_ENABLED, STREAM_THREADS
    
    if not STREAMING_ENABLED:
        return
    
    log_message("Stopping screen streaming...")
    STREAMING_ENABLED = False
    
    # Wait for threads to finish
    for thread in STREAM_THREADS:
        thread.join(timeout=2.0)
    
    STREAM_THREADS.clear()
    log_message("Screen streaming stopped")
    stop_webrtc_streaming()

def screen_capture_worker(agent_id):
    """Worker thread for screen capture."""
    global STREAMING_ENABLED, capture_queue
    
    if not MSS_AVAILABLE or not NUMPY_AVAILABLE or not CV2_AVAILABLE:
        log_message("Required modules not available for screen capture", "error")
        return
    
    import mss
    import numpy as np
    import cv2
    
    with mss.mss() as sct:
        monitors = sct.monitors
        monitor_index = 1
        width = monitors[monitor_index][2] - monitors[monitor_index][0]
        height = monitors[monitor_index][3] - monitors[monitor_index][1]
        
        # Scale down if too large
        if width > 1280:
            scale = 1280 / width
            width = int(width * scale)
            height = int(height * scale)
        
        frame_time = 1.0 / TARGET_FPS
        
        while STREAMING_ENABLED:
            start = time.time()
            
            try:
                sct_img = sct.grab(monitors[monitor_index])
                img = np.array(sct_img)
                
                if img.shape[1] != width or img.shape[0] != height:
                    img = cv2.resize(img, (width, height), interpolation=cv2.INTER_AREA)
                
                if img.shape[2] == 4:  # BGRA to BGR
                    img = cv2.cvtColor(img, cv2.COLOR_BGRA2BGR)
                
                # Non-blocking put, drop oldest if full
                try:
                    if capture_queue.full():
                        capture_queue.get_nowait()
                    capture_queue.put_nowait(img)
                except queue.Full:
                    pass
                    
            except Exception as e:
                log_message(f"Screen capture error: {e}", "error")
                continue
            
            # Maintain target FPS
            elapsed = time.time() - start
            sleep_time = max(0, frame_time - elapsed)
            if sleep_time > 0:
                time.sleep(sleep_time)

def screen_encode_worker(agent_id):
    """Worker thread for screen encoding."""
    global STREAMING_ENABLED, capture_queue, encode_queue
    
    if not CV2_AVAILABLE:
        log_message("OpenCV not available for screen encoding", "error")
        return
    
    import cv2
    
    while STREAMING_ENABLED:
        try:
            img = capture_queue.get(timeout=0.5)
        except queue.Empty:
            continue
        
        try:
            # JPEG encoding
            is_success, encoded = cv2.imencode('.jpg', img, [cv2.IMWRITE_JPEG_QUALITY, 80])
            
            if is_success:
                try:
                    if encode_queue.full():
                        encode_queue.get_nowait()
                    encode_queue.put_nowait(encoded.tobytes())
                except queue.Full:
                    pass
                    
        except Exception as e:
            log_message(f"Screen encoding error: {e}", "error")
            continue

def screen_send_worker(agent_id):
    """Worker thread for sending screen frames."""
    global STREAMING_ENABLED, encode_queue
    
    # Import socketio here to avoid circular import
    try:
        from socket_client import get_socket_client
        sio = get_socket_client()
    except ImportError:
        log_message("Socket client not available", "error")
        return
    
    while STREAMING_ENABLED:
        try:
            frame = encode_queue.get(timeout=0.5)
        except queue.Empty:
            continue
        
        try:
            if sio and hasattr(sio, 'emit'):
                sio.emit('screen_frame', {'agent_id': agent_id, 'frame': frame})
        except Exception as e:
            log_message(f"Screen frame send error: {e}", "error")
            continue

def stream_screen_h264_socketio(agent_id):
    """Modern H.264 screen streaming via Socket.IO."""
    return start_streaming(agent_id)

# Audio streaming functions
def start_audio_streaming(agent_id, mode='auto'):
    """Start audio streaming."""
    global AUDIO_STREAMING_ENABLED, AUDIO_STREAM_THREADS, audio_capture_queue, audio_encode_queue
    
    if AUDIO_STREAMING_ENABLED:
        log_message("Audio streaming already active")
        return True
    if (mode == 'webrtc' or mode == 'auto') and AIORTC_AVAILABLE:
        ok = start_webrtc_streaming(agent_id, kind='audio')
        if ok:
            log_message("Audio streaming started via WebRTC")
            return True
        if mode != 'auto':
            return False
    if not PYAUDIO_AVAILABLE:
        log_message("PyAudio not available for audio streaming", "error")
        return False
    log_message("Starting audio streaming...")
    
    # Initialize queues
    audio_capture_queue = queue.Queue(maxsize=AUDIO_CAPTURE_QUEUE_SIZE)
    audio_encode_queue = queue.Queue(maxsize=AUDIO_ENCODE_QUEUE_SIZE)
    
    AUDIO_STREAMING_ENABLED = True
    
    # Start worker threads
    threads = [
        threading.Thread(target=audio_capture_worker, args=(agent_id,), daemon=True),
        threading.Thread(target=audio_encode_worker, args=(agent_id,), daemon=True),
        threading.Thread(target=audio_send_worker, args=(agent_id,), daemon=True),
    ]
    
    for thread in threads:
        thread.start()
        AUDIO_STREAM_THREADS.append(thread)
    
    log_message("Audio streaming started successfully")
    return True

def start_webrtc_streaming(agent_id, kind='screen'):
    """Start WebRTC streaming and add requested track."""
    global WEBRTC_ACTIVE, WEBRTC_PC, WEBRTC_THREAD, WEBRTC_AGENT_ID, WEBRTC_TRACKS
    if not AIORTC_AVAILABLE:
        return False
    try:
        from aiortc import RTCPeerConnection, RTCSessionDescription
        from socket_client import get_socket_client
        sio = get_socket_client()
        if sio is None:
            return False
        if kind == 'screen':
            track = _create_screen_track(TARGET_FPS if isinstance(TARGET_FPS, int) else 30)
        elif kind == 'camera':
            track = _create_camera_track(TARGET_CAMERA_FPS if isinstance(TARGET_CAMERA_FPS, int) else 30)
        elif kind == 'audio':
            track = _create_audio_track()
        else:
            track = None
        if track is None:
            return False
        loop = _ensure_webrtc_loop()
        WEBRTC_AGENT_ID = agent_id
        WEBRTC_ACTIVE = True
        def _run():
            async def _start():
                global WEBRTC_PC
                if WEBRTC_PC is None:
                    WEBRTC_PC = RTCPeerConnection()
                WEBRTC_TRACKS[kind] = track
                WEBRTC_PC.addTrack(track)
                @WEBRTC_PC.on("icecandidate")
                def on_ice(cand):
                    try:
                        if cand:
                            sio.emit('webrtc_ice_candidate', {
                                'agent_id': agent_id,
                                'candidate': cand
                            })
                    except Exception:
                        pass
                offer = await WEBRTC_PC.createOffer()
                await WEBRTC_PC.setLocalDescription(offer)
                try:
                    sio.emit('webrtc_offer', {
                        'agent_id': agent_id,
                        'offer': offer.sdp
                    })
                except Exception:
                    pass
            import asyncio
            asyncio.run_coroutine_threadsafe(_start(), loop).result()
        WEBRTC_THREAD = threading.Thread(target=_run, daemon=True)
        WEBRTC_THREAD.start()
        return True
    except Exception as e:
        log_message(f"WebRTC start error: {e}", "error")
        WEBRTC_ACTIVE = False
        return False

def handle_webrtc_answer(answer_sdp):
    """Apply WebRTC answer from controller."""
    global WEBRTC_PC
    if not AIORTC_AVAILABLE or WEBRTC_PC is None:
        return False
    try:
        from aiortc import RTCSessionDescription
        loop = _ensure_webrtc_loop()
        async def _apply():
            await WEBRTC_PC.setRemoteDescription(RTCSessionDescription(sdp=answer_sdp, type='answer'))
        import asyncio
        asyncio.run_coroutine_threadsafe(_apply(), loop).result()
        return True
    except Exception as e:
        log_message(f"Apply answer error: {e}", "error")
        return False

def add_remote_ice_candidate(candidate):
    """Add ICE candidate from controller."""
    global WEBRTC_PC
    if not AIORTC_AVAILABLE or WEBRTC_PC is None:
        return False
    try:
        loop = _ensure_webrtc_loop()
        async def _add():
            await WEBRTC_PC.addIceCandidate(candidate)
        import asyncio
        asyncio.run_coroutine_threadsafe(_add(), loop).result()
        return True
    except Exception as e:
        log_message(f"Add ICE candidate error: {e}", "error")
        return False

def stop_webrtc_streaming():
    """Stop WebRTC streaming."""
    global WEBRTC_PC, WEBRTC_ACTIVE, WEBRTC_TRACK
    if not AIORTC_AVAILABLE:
        return
    try:
        loop = _ensure_webrtc_loop()
        async def _stop():
            try:
                if WEBRTC_PC:
                    await WEBRTC_PC.close()
            finally:
                return True
        import asyncio
        asyncio.run_coroutine_threadsafe(_stop(), loop).result()
    except Exception:
        pass
    WEBRTC_PC = None
    WEBRTC_ACTIVE = False

def stop_audio_streaming():
    """Stop audio streaming."""
    global AUDIO_STREAMING_ENABLED, AUDIO_STREAM_THREADS
    
    if not AUDIO_STREAMING_ENABLED:
        return
    
    log_message("Stopping audio streaming...")
    AUDIO_STREAMING_ENABLED = False
    
    # Wait for threads to finish
    for thread in AUDIO_STREAM_THREADS:
        thread.join(timeout=2.0)
    
    AUDIO_STREAM_THREADS.clear()
    log_message("Audio streaming stopped")

def audio_capture_worker(agent_id):
    """Worker thread for audio capture."""
    global AUDIO_STREAMING_ENABLED, audio_capture_queue
    
    if not PYAUDIO_AVAILABLE:
        log_message("PyAudio not available for audio capture", "error")
        return
    
    import pyaudio
    
    try:
        p = pyaudio.PyAudio()
        
        # Open audio stream
        stream = p.open(
            format=FORMAT,
            channels=CHANNELS,
            rate=RATE,
            input=True,
            frames_per_buffer=CHUNK
        )
        
        while AUDIO_STREAMING_ENABLED:
            try:
                data = stream.read(CHUNK, exception_on_overflow=False)
                
                # Non-blocking put
                try:
                    if audio_capture_queue.full():
                        audio_capture_queue.get_nowait()
                    audio_capture_queue.put_nowait(data)
                except queue.Full:
                    pass
                    
            except Exception as e:
                log_message(f"Audio capture error: {e}", "error")
                continue
        
        stream.stop_stream()
        stream.close()
        p.terminate()
        
    except Exception as e:
        log_message(f"Audio capture initialization failed: {e}", "error")

def audio_encode_worker(agent_id):
    """Worker thread for audio encoding."""
    global AUDIO_STREAMING_ENABLED, audio_capture_queue, audio_encode_queue
    
    while AUDIO_STREAMING_ENABLED:
        try:
            audio_data = audio_capture_queue.get(timeout=0.5)
        except queue.Empty:
            continue
        
        try:
            # Base64 encode audio data
            encoded_data = base64.b64encode(audio_data).decode('utf-8')
            
            try:
                if audio_encode_queue.full():
                    audio_encode_queue.get_nowait()
                audio_encode_queue.put_nowait(encoded_data)
            except queue.Full:
                pass
                
        except Exception as e:
            log_message(f"Audio encoding error: {e}", "error")
            continue

def audio_send_worker(agent_id):
    """Worker thread for sending audio data."""
    global AUDIO_STREAMING_ENABLED, audio_encode_queue
    
    # Import socketio here to avoid circular import
    try:
        from socket_client import get_socket_client
        sio = get_socket_client()
    except ImportError:
        log_message("Socket client not available", "error")
        return
    
    while AUDIO_STREAMING_ENABLED:
        try:
            audio_data = audio_encode_queue.get(timeout=0.5)
        except queue.Empty:
            continue
        
        try:
            if sio and hasattr(sio, 'emit'):
                sio.emit('audio_frame', {'agent_id': agent_id, 'audio': audio_data})
        except Exception as e:
            log_message(f"Audio frame send error: {e}", "error")
            continue

# Camera streaming functions
def start_camera_streaming(agent_id, mode='auto'):
    """Start camera streaming."""
    global CAMERA_STREAMING_ENABLED, CAMERA_STREAM_THREADS, camera_capture_queue, camera_encode_queue
    
    if CAMERA_STREAMING_ENABLED:
        log_message("Camera streaming already active")
        return True
    if (mode == 'webrtc' or mode == 'auto') and AIORTC_AVAILABLE:
        ok = start_webrtc_streaming(agent_id, kind='camera')
        if ok:
            log_message("Camera streaming started via WebRTC")
            return True
        if mode != 'auto':
            return False
    if not CV2_AVAILABLE:
        log_message("OpenCV not available for camera streaming", "error")
        return False
    log_message("Starting camera streaming...")
    
    # Initialize queues
    camera_capture_queue = queue.Queue(maxsize=CAPTURE_QUEUE_SIZE)
    camera_encode_queue = queue.Queue(maxsize=ENCODE_QUEUE_SIZE)
    
    CAMERA_STREAMING_ENABLED = True
    
    # Start worker threads
    threads = [
        threading.Thread(target=camera_capture_worker, args=(agent_id,), daemon=True),
        threading.Thread(target=camera_encode_worker, args=(agent_id,), daemon=True),
        threading.Thread(target=camera_send_worker, args=(agent_id,), daemon=True),
    ]
    
    for thread in threads:
        thread.start()
        CAMERA_STREAM_THREADS.append(thread)
    
    log_message("Camera streaming started successfully")
    return True

def stop_camera_streaming():
    """Stop camera streaming."""
    global CAMERA_STREAMING_ENABLED, CAMERA_STREAM_THREADS
    
    if not CAMERA_STREAMING_ENABLED:
        return
    
    log_message("Stopping camera streaming...")
    CAMERA_STREAMING_ENABLED = False
    
    # Wait for threads to finish
    for thread in CAMERA_STREAM_THREADS:
        thread.join(timeout=2.0)
    
    CAMERA_STREAM_THREADS.clear()
    log_message("Camera streaming stopped")

def camera_capture_worker(agent_id):
    """Worker thread for camera capture."""
    global CAMERA_STREAMING_ENABLED, camera_capture_queue
    
    if not CV2_AVAILABLE:
        log_message("OpenCV not available for camera capture", "error")
        return
    
    import cv2
    
    try:
        # Open camera
        cap = cv2.VideoCapture(0)
        if not cap.isOpened():
            log_message("Could not open camera", "error")
            return
        
        # Set camera properties
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
        cap.set(cv2.CAP_PROP_FPS, TARGET_CAMERA_FPS)
        
        frame_time = 1.0 / TARGET_CAMERA_FPS
        
        while CAMERA_STREAMING_ENABLED:
            start = time.time()
            
            try:
                ret, frame = cap.read()
                if not ret:
                    continue
                
                # Non-blocking put
                try:
                    if camera_capture_queue.full():
                        camera_capture_queue.get_nowait()
                    camera_capture_queue.put_nowait(frame)
                except queue.Full:
                    pass
                    
            except Exception as e:
                log_message(f"Camera capture error: {e}", "error")
                continue
            
            # Maintain target FPS
            elapsed = time.time() - start
            sleep_time = max(0, frame_time - elapsed)
            if sleep_time > 0:
                time.sleep(sleep_time)
        
        cap.release()
        
    except Exception as e:
        log_message(f"Camera capture initialization failed: {e}", "error")

def camera_encode_worker(agent_id):
    """Worker thread for camera encoding."""
    global CAMERA_STREAMING_ENABLED, camera_capture_queue, camera_encode_queue
    
    if not CV2_AVAILABLE:
        log_message("OpenCV not available for camera encoding", "error")
        return
    
    import cv2
    
    while CAMERA_STREAMING_ENABLED:
        try:
            frame = camera_capture_queue.get(timeout=0.5)
        except queue.Empty:
            continue
        
        try:
            # JPEG encoding
            is_success, encoded = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
            
            if is_success:
                try:
                    if camera_encode_queue.full():
                        camera_encode_queue.get_nowait()
                    camera_encode_queue.put_nowait(encoded.tobytes())
                except queue.Full:
                    pass
                    
        except Exception as e:
            log_message(f"Camera encoding error: {e}", "error")
            continue

def camera_send_worker(agent_id):
    """Worker thread for sending camera frames."""
    global CAMERA_STREAMING_ENABLED, camera_encode_queue
    
    # Import socketio here to avoid circular import
    try:
        from socket_client import get_socket_client
        sio = get_socket_client()
    except ImportError:
        log_message("Socket client not available", "error")
        return
    
    while CAMERA_STREAMING_ENABLED:
        try:
            frame = camera_encode_queue.get(timeout=0.5)
        except queue.Empty:
            continue
        
        try:
            if sio and hasattr(sio, 'emit'):
                sio.emit('camera_frame', {'agent_id': agent_id, 'frame': frame})
        except Exception as e:
            log_message(f"Camera frame send error: {e}", "error")
            continue

def stream_camera_h264_socketio(agent_id):
    """Camera streaming via Socket.IO."""
    return start_camera_streaming(agent_id)

# High-performance capture classes
class HighPerformanceCapture:
    """High-performance screen capture with hardware acceleration."""
    
    def __init__(self):
        self.capture_active = False
        self.capture_thread = None
        
    def start_capture(self, agent_id):
        """Start high-performance capture."""
        if self.capture_active:
            return True
        
        if not MSS_AVAILABLE or not NUMPY_AVAILABLE or not CV2_AVAILABLE:
            log_message("Required modules not available for high-performance capture", "error")
            return False
        
        self.capture_active = True
        self.capture_thread = threading.Thread(target=self._capture_loop, args=(agent_id,), daemon=True)
        self.capture_thread.start()
        
        log_message("High-performance capture started")
        return True
    
    def stop_capture(self):
        """Stop high-performance capture."""
        self.capture_active = False
        if self.capture_thread:
            self.capture_thread.join(timeout=2.0)
        log_message("High-performance capture stopped")
    
    def _capture_loop(self, agent_id):
        """Main capture loop with optimizations."""
        import mss
        import numpy as np
        import cv2
        
        with mss.mss() as sct:
            monitor = sct.monitors[1]
            
            while self.capture_active:
                try:
                    # High-speed capture
                    sct_img = sct.grab(monitor)
                    img = np.array(sct_img)
                    
                    # Fast processing
                    if img.shape[2] == 4:
                        img = cv2.cvtColor(img, cv2.COLOR_BGRA2BGR)
                    
                    # Encode and send
                    _, encoded = cv2.imencode('.jpg', img, [cv2.IMWRITE_JPEG_QUALITY, 60])
                    
                    # Send via socket
                    try:
                        from socket_client import get_socket_client
                        sio = get_socket_client()
                        if sio and hasattr(sio, 'emit'):
                            sio.emit('screen_frame', {'agent_id': agent_id, 'frame': encoded.tobytes()})
                    except:
                        pass
                    
                    # Small delay for CPU
                    time.sleep(1.0 / 60)  # 60 FPS max
                    
                except Exception as e:
                    log_message(f"High-performance capture error: {e}", "error")
                    time.sleep(0.1)

class AdaptiveQualityManager:
    """Manages adaptive quality based on network conditions."""
    
    def __init__(self):
        self.current_quality = 80
        self.min_quality = 30
        self.max_quality = 95
        
    def adjust_quality(self, network_delay, bandwidth):
        """Adjust quality based on network conditions."""
        if network_delay > 500:  # High latency
            self.current_quality = max(self.min_quality, self.current_quality - 10)
        elif network_delay < 100:  # Low latency
            self.current_quality = min(self.max_quality, self.current_quality + 5)
        
        if bandwidth < 1000000:  # Low bandwidth (1 Mbps)
            self.current_quality = max(self.min_quality, self.current_quality - 15)
        elif bandwidth > 5000000:  # High bandwidth (5 Mbps)
            self.current_quality = min(self.max_quality, self.current_quality + 5)
        
        return self.current_quality
    
    def get_quality(self):
        """Get current quality setting."""
        return self.current_quality
