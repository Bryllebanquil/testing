import React, { useState, useEffect, useRef } from 'react';
import { useSocket } from './SocketProvider';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { 
  Play, 
  Pause, 
  Square, 
  Volume2, 
  VolumeX, 
  Maximize2, 
  Settings,
  Monitor,
  Camera,
  Mic,
  AlertCircle
} from 'lucide-react';
import { cn } from './ui/utils';
import { toast } from 'sonner';
import apiClient from '../services/api';

interface StreamViewerProps {
  agentId: string | null;
  type: 'screen' | 'camera' | 'audio';
  title: string;
}

export function StreamViewer({ agentId, type, title }: StreamViewerProps) {
  const { sendCommand, socket } = useSocket();
  const [isStreaming, setIsStreaming] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [quality, setQuality] = useState('high');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [frameCount, setFrameCount] = useState(0);
  const [lastFrameTime, setLastFrameTime] = useState<number>(0);
  const [fps, setFps] = useState(0);
  const [bandwidth, setBandwidth] = useState(0);
  const [hasError, setHasError] = useState(false);
  const [isWebRTCActive, setIsWebRTCActive] = useState(false);
  const [transportMode, setTransportMode] = useState<'auto' | 'webrtc' | 'fallback'>('fallback');
  const [webrtcIceServers, setWebrtcIceServers] = useState<RTCIceServer[]>([]);
  
  const imgRef = useRef<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rtcPcRef = useRef<RTCPeerConnection | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioQueueRef = useRef<Float32Array[]>([]);
  const isPlayingAudioRef = useRef(false);
  const webrtcTimeoutRef = useRef<number | null>(null);
  const fallbackTriggeredRef = useRef(false);
  const fpsIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const frameCountRef = useRef(0);
  const lastMouseEmitRef = useRef<number>(0);
  const lastKeyEmitRef = useRef<number>(0);

  const getStreamIcon = () => {
    switch (type) {
      case 'screen': return Monitor;
      case 'camera': return Camera;
      case 'audio': return Mic;
      default: return Monitor;
    }
  };

  const StreamIcon = getStreamIcon();

  // Initialize Audio Context
  const initAudioContext = () => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: 44100,
        latencyHint: 'interactive'
      });
    }
    return audioContextRef.current;
  };

  // Play audio frame using Web Audio API
  const playAudioFrame = async (payload: string | ArrayBuffer | Uint8Array) => {
    try {
      const audioContext = initAudioContext();
      
      // Normalize payload to Uint8Array
      let bytes: Uint8Array;
      if (typeof payload === 'string') {
        const binaryString = atob(payload);
        bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
      } else if (payload instanceof Uint8Array) {
        bytes = payload;
      } else if (payload instanceof ArrayBuffer) {
        bytes = new Uint8Array(payload);
      } else {
        return;
      }
      
      // For PCM audio (16-bit samples)
      // Convert bytes to Float32Array for Web Audio API
      const samples = new Int16Array(bytes.buffer);
      const floatSamples = new Float32Array(samples.length);
      for (let i = 0; i < samples.length; i++) {
        floatSamples[i] = samples[i] / 32768.0; // Convert to -1.0 to 1.0 range
      }
      
      // Add to audio queue
      audioQueueRef.current.push(floatSamples);
      
      // Start playing if not already playing
      if (!isPlayingAudioRef.current) {
        isPlayingAudioRef.current = true;
        scheduleAudioPlayback();
      }
    } catch (error) {
      console.error('Error processing audio frame:', error);
    }
  };

  // Schedule audio playback from queue
  const scheduleAudioPlayback = () => {
    const audioContext = audioContextRef.current;
    if (!audioContext) return;

    const playNextChunk = () => {
      if (audioQueueRef.current.length === 0) {
        isPlayingAudioRef.current = false;
        return;
      }

      const samples = audioQueueRef.current.shift();
      if (!samples) return;

      // Create audio buffer
      const audioBuffer = audioContext.createBuffer(1, samples.length, 44100);
      const channelData = audioBuffer.getChannelData(0);
      channelData.set(samples);

      // Create buffer source and play
      const source = audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioContext.destination);
      source.start();

      // Schedule next chunk
      const duration = samples.length / 44100;
      setTimeout(playNextChunk, duration * 1000 * 0.9); // Slight overlap to prevent gaps
    };

    playNextChunk();
  };

  // Cleanup audio context on unmount
  useEffect(() => {
    return () => {
      if (audioContextRef.current) {
        audioContextRef.current.close();
        audioContextRef.current = null;
      }
      audioQueueRef.current = [];
      isPlayingAudioRef.current = false;
    };
  }, []);

  // Calculate FPS every second
  useEffect(() => {
    if (isStreaming) {
      fpsIntervalRef.current = setInterval(() => {
        setFps(frameCountRef.current);
        frameCountRef.current = 0;
      }, 1000);
    } else {
      if (fpsIntervalRef.current) {
        clearInterval(fpsIntervalRef.current);
        fpsIntervalRef.current = null;
      }
      setFps(0);
      frameCountRef.current = 0;
    }

    return () => {
      if (fpsIntervalRef.current) {
        clearInterval(fpsIntervalRef.current);
      }
    };
  }, [isStreaming]);

  useEffect(() => {
    let active = true;
    (async () => {
      const s = await apiClient.getSettings();
      const arr = (s?.data?.webrtc?.iceServers || []) as string[];
      const servers: RTCIceServer[] = Array.isArray(arr)
        ? arr.map((u: any) => typeof u === 'string' ? ({ urls: u }) : u)
        : [];
      if (active) setWebrtcIceServers(servers);
    })();
    return () => { active = false; };
  }, []);

  // WebRTC viewer: signaling and media attachment
  useEffect(() => {
    if (!socket || !isStreaming || !agentId) return;
    if (transportMode === 'fallback') return;
    const handleViewerOffer = async (data: { offer: string; type: string }) => {
      try {
        if (webrtcTimeoutRef.current) {
          clearTimeout(webrtcTimeoutRef.current);
          webrtcTimeoutRef.current = null;
        }
        const pc = new RTCPeerConnection({
          iceServers: webrtcIceServers.length > 0 ? webrtcIceServers : [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
            { urls: 'stun:stun3.l.google.com:19302' },
            { urls: 'stun:stun4.l.google.com:19302' }
          ]
        });
        rtcPcRef.current = pc;
        const inboundStream = new MediaStream();
        if (videoRef.current) {
          videoRef.current.srcObject = inboundStream;
          videoRef.current.muted = isMuted;
          await videoRef.current.play().catch(() => {});
        }
        pc.ontrack = (event) => {
          for (const track of event.streams[0]?.getTracks?.() || []) {
            inboundStream.addTrack(track);
          }
          try {
            const hasAudio = !!event.streams[0]?.getAudioTracks?.()?.length;
            if (hasAudio && videoRef.current) {
              videoRef.current.muted = isMuted;
              videoRef.current.play().catch(() => {});
            }
          } catch {}
          if (webrtcTimeoutRef.current) {
            clearTimeout(webrtcTimeoutRef.current);
            webrtcTimeoutRef.current = null;
          }
          frameCountRef.current++;
          setFrameCount((prev: number) => prev + 1);
          setIsWebRTCActive(true);
          setHasError(false);
        };
        pc.onicecandidate = (ev) => {
          if (ev.candidate) {
            socket.emit('webrtc_viewer_ice_candidate', { candidate: ev.candidate });
          }
        };
        pc.onconnectionstatechange = () => {
          const state = pc.connectionState;
          if (state === 'connected') {
            if (webrtcTimeoutRef.current) {
              clearTimeout(webrtcTimeoutRef.current);
              webrtcTimeoutRef.current = null;
            }
          } else if ((state === 'failed' || state === 'disconnected') && transportMode === 'auto') {
            if (fallbackTriggeredRef.current) return;
            fallbackTriggeredRef.current = true;
            setTransportMode('fallback');
            setIsWebRTCActive(false);
            if (socket) {
              socket.emit('webrtc_viewer_disconnect');
            }
            if (agentId) {
              let cmd = '';
              if (type === 'screen') cmd = 'start-stream';
              else if (type === 'camera') cmd = 'start-camera';
              else cmd = 'start-audio';
              sendCommand(agentId, cmd);
            }
          }
        };
        const remoteDesc: RTCSessionDescriptionInit = {
          type: data.type as RTCSessionDescriptionInit['type'],
          sdp: data.offer
        };
        await pc.setRemoteDescription(remoteDesc);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('webrtc_viewer_answer', { answer: answer.sdp });
      } catch (e) {
        setIsWebRTCActive(false);
      }
    };
    const handleServerIce = async (payload: { agent_id?: string; candidate: any }) => {
      try {
        if (!rtcPcRef.current) return;
        await rtcPcRef.current.addIceCandidate(payload.candidate);
      } catch {
        /* no-op */
      }
    };
    socket.on('webrtc_viewer_offer', handleViewerOffer);
    socket.on('webrtc_ice_candidate', handleServerIce);
    socket.emit('webrtc_viewer_connect', { agent_id: agentId });
    return () => {
      socket.off('webrtc_viewer_offer', handleViewerOffer);
      socket.off('webrtc_ice_candidate', handleServerIce);
    };
  }, [socket, isStreaming, agentId, transportMode, webrtcIceServers]);

  // Listen for frame events
  useEffect(() => {
    if (!isStreaming || !agentId) return;

    const eventName = type === 'screen' ? 'screen_frame' : type === 'camera' ? 'camera_frame' : 'audio_frame';

    const handleFrame = (event: any) => {
      const data = event.detail;
      
      // Check if frame is for this agent
      if (data.agent_id !== agentId) return;

      setHasError(false);
      
      try {
        const frame = data.frame;
        
        if (type === 'audio') {
          // Audio handling - decode and play
          try {
            playAudioFrame(frame);
            frameCountRef.current++;
            setFrameCount((prev: number) => prev + 1);
          } catch (audioError) {
            console.error('Error playing audio frame:', audioError);
          }
        } else {
          const canvas = canvasRef.current;
          if (canvas) {
            try {
              let base64 = '';
              if (typeof frame === 'string') {
                base64 = frame.startsWith('data:') ? frame.split(',')[1] || '' : frame;
              }
              if (base64) {
                const binary = atob(base64);
                const bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) {
                  bytes[i] = binary.charCodeAt(i);
                }
                const blob = new Blob([bytes], { type: 'image/jpeg' });
                createImageBitmap(blob).then((bitmap) => {
                  if (!canvas) return;
                  if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
                    canvas.width = bitmap.width;
                    canvas.height = bitmap.height;
                  }
                  const ctx = canvas.getContext('2d');
                  if (ctx) {
                    ctx.drawImage(bitmap, 0, 0);
                  }
                }).catch(() => {});
              }
            } finally {
              frameCountRef.current++;
              setFrameCount((prev: number) => prev + 1);
              const now = Date.now();
              if (lastFrameTime > 0) {
                const timeDiff = now - lastFrameTime;
                if (timeDiff > 0) {
                  const currentFps = 1000 / timeDiff;
                  setBandwidth(Math.round((currentFps * 50) / 1024));
                }
              }
              setLastFrameTime(now);
            }
          }
        }
      } catch (error) {
        console.error(`Error displaying ${type} frame:`, error);
        setHasError(true);
      }
    };
    window.addEventListener(eventName, handleFrame);

    return () => {
      window.removeEventListener(eventName, handleFrame);
    };
  }, [isStreaming, agentId, type, lastFrameTime]);

  // Also listen for audio frames when viewing screen/camera in fallback mode
  useEffect(() => {
    if (!isStreaming || !agentId) return;
    if (!(type === 'screen' || type === 'camera')) return;
    const handleAudioFrame = (event: any) => {
      const data = event.detail;
      if (data.agent_id !== agentId) return;
      try {
        playAudioFrame(data.frame);
        frameCountRef.current++;
        setFrameCount((prev: number) => prev + 1);
      } catch {}
    };
    window.addEventListener('audio_frame', handleAudioFrame);
    return () => {
      window.removeEventListener('audio_frame', handleAudioFrame);
    };
  }, [isStreaming, agentId, type]);

  const handleStartStop = () => {
    if (!agentId) {
      toast.error('Please select an agent first');
      return;
    }

    if (isStreaming) {
      // Stop streaming
      let command = '';
      if (transportMode === 'fallback') {
        switch (type) {
          case 'screen':
            command = 'stop-stream';
            break;
          case 'camera':
            command = 'stop-camera';
            break;
          case 'audio':
            command = 'stop-audio';
            break;
        }
      } else {
        command = 'stop-webrtc';
      }
      
      sendCommand(agentId, command);
      setIsStreaming(false);
      setFrameCount(0);
      setFps(0);
      setBandwidth(0);
      setHasError(false);
      setIsWebRTCActive(false);
      if (socket) {
        socket.emit('webrtc_viewer_disconnect');
      }
      
      if (imgRef.current) {
        imgRef.current.src = '';
      }
      if (canvasRef.current) {
        const ctx = canvasRef.current.getContext('2d');
        if (ctx) {
          ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
        }
      }
      
      // Cleanup audio context for audio streams
      if (type === 'audio' && audioContextRef.current) {
        audioContextRef.current.close();
        audioContextRef.current = null;
        audioQueueRef.current = [];
        isPlayingAudioRef.current = false;
      }
      
      toast.success(`${type.charAt(0).toUpperCase() + type.slice(1)} stream stopped`);
    } else {
      // Start streaming
      let command = '';
      if (transportMode === 'fallback') {
        switch (type) {
          case 'screen':
            command = 'start-stream';
            break;
          case 'camera':
            command = 'start-camera';
            break;
          case 'audio':
            command = 'start-audio';
            break;
        }
      } else {
        switch (type) {
          case 'screen':
            command = 'start-webrtc-screen';
            break;
          case 'camera':
            command = 'start-webrtc-camera';
            break;
          case 'audio':
            command = 'start-webrtc-audio';
            break;
        }
      }
      
      sendCommand(agentId, command);
      setIsStreaming(true);
      setIsWebRTCActive(false);
      setHasError(false);
      fallbackTriggeredRef.current = false;
      if (transportMode === 'auto') {
        if (webrtcTimeoutRef.current) {
          clearTimeout(webrtcTimeoutRef.current);
          webrtcTimeoutRef.current = null;
        }
        webrtcTimeoutRef.current = window.setTimeout(() => {
          if (fallbackTriggeredRef.current) return;
          fallbackTriggeredRef.current = true;
          setTransportMode('fallback');
          setIsWebRTCActive(false);
          if (socket) {
            socket.emit('webrtc_viewer_disconnect');
          }
          if (agentId) {
            let cmd = '';
            if (type === 'screen') cmd = 'start-stream';
            else if (type === 'camera') cmd = 'start-camera';
            else cmd = 'start-audio';
            sendCommand(agentId, cmd);
          }
        }, 8000);
      }
      toast.success(`${type.charAt(0).toUpperCase() + type.slice(1)} stream started`);
    }
  };

  const handleQualityChange = (newQuality: string) => {
    setQuality(newQuality);
    
    if (agentId && isStreaming && socket) {
      const q = newQuality === 'ultra' ? 'high' : (newQuality as 'low' | 'medium' | 'high' | 'auto');
      socket.emit('webrtc_set_quality', { agent_id: agentId, quality: q });
    }
    
    toast.info(`Quality set to ${newQuality}`);
  };

  const toggleFullscreen = () => {
    setIsFullscreen(!isFullscreen);
  };

  const emitMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!socket || !agentId) return;
    if (!isStreaming || !(type === 'screen' || type === 'camera')) return;
    const now = Date.now();
    if (now - (lastMouseEmitRef.current || 0) < 15) return;
    lastMouseEmitRef.current = now;
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const nx = Math.max(0, Math.min(1, x / rect.width));
    const ny = Math.max(0, Math.min(1, y / rect.height));
    socket.emit('live_mouse_move', {
      agent_id: agentId,
      x: nx,
      y: ny,
      buttons: e.buttons || 0,
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    });
  };

  const emitMouseClick = (action: 'down' | 'up', e: React.MouseEvent<HTMLDivElement>) => {
    if (!socket || !agentId) return;
    if (!isStreaming || !(type === 'screen' || type === 'camera')) return;
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const nx = Math.max(0, Math.min(1, x / rect.width));
    const ny = Math.max(0, Math.min(1, y / rect.height));
    socket.emit('live_mouse_click', {
      agent_id: agentId,
      type: action,
      button: e.button,
      x: nx,
      y: ny
    });
  };

  const emitKey = (action: 'down' | 'up', e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!socket || !agentId) return;
    if (!isStreaming || !(type === 'screen' || type === 'camera')) return;
    const now = Date.now();
    if (now - (lastKeyEmitRef.current || 0) < 10) return;
    lastKeyEmitRef.current = now;
    socket.emit('live_key_press', {
      agent_id: agentId,
      type: action,
      key: e.key,
      code: e.code,
      altKey: e.altKey,
      ctrlKey: e.ctrlKey,
      shiftKey: e.shiftKey,
      metaKey: e.metaKey
    });
  };

  // Reset streaming state when agent changes
  useEffect(() => {
    if (isStreaming) {
      setIsStreaming(false);
      setFrameCount(0);
      setFps(0);
      setBandwidth(0);
      if (imgRef.current) {
        imgRef.current.src = '';
      }
      if (rtcPcRef.current) {
        try {
          rtcPcRef.current.getSenders().forEach((s: RTCRtpSender) => s.track?.stop());
          rtcPcRef.current.getReceivers().forEach((r: RTCRtpReceiver) => r.track?.stop());
          rtcPcRef.current.close();
        } catch {}
        rtcPcRef.current = null;
      }
      if (socket) {
        socket.emit('webrtc_viewer_disconnect');
      }
      if (videoRef.current) {
        try {
          const ms = videoRef.current.srcObject as MediaStream | null;
          ms?.getTracks().forEach(t => t.stop());
        } catch {}
        videoRef.current.srcObject = null;
      }
    }
  }, [agentId]);

  useEffect(() => {
    if (!socket || !agentId) return;
    if (!isStreaming || !(transportMode === 'webrtc' || (transportMode === 'auto' && isWebRTCActive))) return;
    let t: any = null;
    let lastUpdate = 0;
    t = setInterval(() => {
      const now = Date.now();
      if (now - lastUpdate < 3000) return;
      lastUpdate = now;
      const stats = { fps, bandwidth };
      if (fps < 20 && (quality === 'high' || quality === 'medium' || quality === 'ultra')) {
        setQuality('low');
        socket.emit('webrtc_quality_change', { agent_id: agentId, quality: 'low', bandwidth_stats: stats });
      } else if (fps < 35 && (quality === 'high' || quality === 'ultra')) {
        setQuality('medium');
        socket.emit('webrtc_quality_change', { agent_id: agentId, quality: 'medium', bandwidth_stats: stats });
      } else if (fps > 55 && quality === 'low') {
        setQuality('medium');
        socket.emit('webrtc_quality_change', { agent_id: agentId, quality: 'medium', bandwidth_stats: stats });
      } else if (fps > 55 && quality === 'medium') {
        setQuality('high');
        socket.emit('webrtc_quality_change', { agent_id: agentId, quality: 'high', bandwidth_stats: stats });
      }
    }, 1500);
    return () => {
      if (t) clearInterval(t);
    };
  }, [socket, agentId, isStreaming, transportMode, isWebRTCActive, fps, bandwidth, quality]);

  return (
    <Card className={cn("transition-all", isFullscreen && "fixed inset-4 z-50")}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <StreamIcon className="h-4 w-4" />
            <CardTitle className="text-sm">{title}</CardTitle>
            {agentId && (
              <Badge variant="outline" className="text-xs">
                {agentId.substring(0, 8)}
              </Badge>
            )}
          </div>
          
          <div className="flex items-center space-x-2">
            <Select value={quality} onValueChange={handleQualityChange}>
              <SelectTrigger className="w-20 h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="low">Low (30 FPS)</SelectItem>
                <SelectItem value="medium">Med (50 FPS)</SelectItem>
                <SelectItem value="high">High (60 FPS)</SelectItem>
                <SelectItem value="ultra">Ultra (60 FPS)</SelectItem>
              </SelectContent>
            </Select>
            <Select value={transportMode} onValueChange={(v: string) => setTransportMode(v as 'auto' | 'webrtc' | 'fallback')}>
              <SelectTrigger className="w-28 h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Auto</SelectItem>
                <SelectItem value="webrtc">WebRTC</SelectItem>
                <SelectItem value="fallback">Fallback</SelectItem>
              </SelectContent>
            </Select>
            {isStreaming && (
              <Badge variant={isWebRTCActive ? "default" : "secondary"} className="text-xs">
                {transportMode === 'auto'
                  ? isWebRTCActive ? 'Auto (WebRTC)' : 'Auto (Fallback)'
                  : transportMode === 'webrtc'
                    ? (isWebRTCActive ? 'WebRTC' : 'WebRTC (connecting)')
                    : 'Fallback'}
              </Badge>
            )}
            
            <Button variant="ghost" size="sm" onClick={toggleFullscreen}>
              <Maximize2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
        
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <Button 
              size="sm" 
              variant={isStreaming ? "destructive" : "default"}
              onClick={handleStartStop}
              disabled={!agentId}
            >
              {isStreaming ? (
                <>
                  <Square className="h-3 w-3 mr-1" />
                  Stop
                </>
              ) : (
                <>
                  <Play className="h-3 w-3 mr-1" />
                  Start
                </>
              )}
            </Button>
            
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setIsMuted(!isMuted);
                // Mute/unmute audio context if it's an audio stream
                if (type === 'audio') {
                  if (audioContextRef.current) {
                    if (!isMuted) {
                      audioContextRef.current.suspend();
                    } else {
                      audioContextRef.current.resume();
                    }
                  }
                } else {
                  const video = videoRef.current;
                  if (video) {
                    if (!isMuted) {
                      video.muted = true;
                    } else {
                      video.muted = false;
                      video.play().catch(() => {});
                    }
                  }
                }
              }}
              disabled={!isStreaming}
            >
              {isMuted ? <VolumeX className="h-3 w-3" /> : <Volume2 className="h-3 w-3" />}
            </Button>
          </div>
          
          <div className="flex items-center space-x-2 text-xs text-muted-foreground">
            {isStreaming && !hasError && (
              <>
                <Badge variant="secondary">{fps} FPS</Badge>
                <Badge variant="secondary">{bandwidth.toFixed(1)} MB/s</Badge>
                <Badge variant="secondary">{frameCount} frames</Badge>
              </>
            )}
            {hasError && (
              <Badge variant="destructive" className="text-xs">
                <AlertCircle className="h-3 w-3 mr-1" />
                Error
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>
      
      <CardContent>
        <div
          ref={containerRef}
          tabIndex={0}
          onMouseMove={emitMouseMove}
          onMouseDown={(e) => emitMouseClick('down', e)}
          onMouseUp={(e) => emitMouseClick('up', e)}
          onKeyDown={(e) => emitKey('down', e)}
          onKeyUp={(e) => emitKey('up', e)}
          className="aspect-video bg-black rounded-lg flex items-center justify-center relative overflow-hidden outline-none"
        >
          {!agentId ? (
            <div className="text-center text-muted-foreground">
              <StreamIcon className="h-12 w-12 mx-auto mb-2 opacity-50" />
              <p className="text-sm">Select an agent to view stream</p>
            </div>
          ) : !isStreaming ? (
            <div className="text-center text-muted-foreground">
              <StreamIcon className="h-12 w-12 mx-auto mb-2 opacity-50" />
              <p className="text-sm">Stream not active</p>
              <p className="text-xs mt-1">Click Start to begin streaming</p>
            </div>
          ) : hasError ? (
            <div className="text-center text-red-400">
              <AlertCircle className="h-12 w-12 mx-auto mb-2" />
              <p className="text-sm">Stream Error</p>
              <p className="text-xs mt-1">No frames received</p>
            </div>
          ) : type === 'audio' ? (
            <div className="w-full h-full bg-gradient-to-br from-purple-900 to-pink-900 flex items-center justify-center">
              <div className="text-white text-center">
                <Mic className="h-16 w-16 mx-auto mb-4 animate-pulse" />
                <p className="text-lg font-medium">Audio Stream Active</p>
                <p className="text-sm opacity-80">Agent: {agentId.substring(0, 8)}</p>
                <div className="mt-4 flex justify-center space-x-1">
                  {[...Array(10)].map((_, i) => (
                    <div 
                      key={i}
                      className="w-1 bg-green-500 rounded-full animate-pulse"
                      style={{ 
                        height: `${Math.random() * 40 + 20}px`,
                        animationDelay: `${i * 0.1}s`
                      }}
                    />
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <>
              {isWebRTCActive ? (
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  className="w-full h-full object-contain"
                />
              ) : (
                <canvas
                  ref={canvasRef}
                  className="w-full h-full object-contain"
                  style={{ display: frameCount > 0 ? 'block' : 'none' }}
                />
              )}
              {!isWebRTCActive && frameCount === 0 && (
                <div className="text-center text-muted-foreground">
                  <StreamIcon className="h-12 w-12 mx-auto mb-2 animate-pulse" />
                  <p className="text-sm">Waiting for frames...</p>
                  <p className="text-xs mt-1">Connecting to agent</p>
                </div>
              )}
            </>
          )}
          
          {isStreaming && ((frameCount > 0 && !hasError) || isWebRTCActive) && (
            <div className="absolute top-2 left-2 flex items-center space-x-2">
              <div className="flex items-center space-x-1 bg-black/70 text-white px-2 py-1 rounded text-xs">
                <div className="w-2 h-2 bg-red-500 rounded-full animate-pulse"></div>
                <span>LIVE</span>
              </div>
              <div className="bg-black/70 text-white px-2 py-1 rounded text-xs">
                {quality.toUpperCase()}
              </div>
              <div className="bg-black/70 text-white px-2 py-1 rounded text-xs">
                {fps} FPS
              </div>
            </div>
          )}
        </div>
        
        {isStreaming && ((frameCount > 0 && !hasError) || isWebRTCActive) && (
          <div className="mt-4 text-xs text-muted-foreground">
            <div className="flex justify-between items-center">
              <span>Status: Active • Frames: {frameCount}{isWebRTCActive ? ' • WebRTC' : ''}</span>
              <span>Bandwidth: {bandwidth.toFixed(1)} MB/s</span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
