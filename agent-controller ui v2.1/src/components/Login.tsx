import { useState, useEffect } from 'react';
import { initializeApp, getApps } from 'firebase/app';
import { getAuth, RecaptchaVerifier, signInWithPhoneNumber } from 'firebase/auth';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Alert, AlertDescription } from './ui/alert';
import { Shield, Eye, EyeOff, Loader2 } from 'lucide-react';
import { useSocket } from './SocketProvider';
import apiClient from '../services/api';

export function Login() {
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [otp, setOtp] = useState('');
  const [qrB64, setQrB64] = useState('');
  const [secret, setSecret] = useState('');
  const [enrolling, setEnrolling] = useState(false);
  const [totpInfo, setTotpInfo] = useState<{ enabled: boolean; enrolled: boolean; issuer?: string } | null>(null);
  const [phone, setPhone] = useState('+639854985962');
  const [smsCode, setSmsCode] = useState('');
  const [idToken, setIdToken] = useState<string | undefined>(undefined);
  const [sendingCode, setSendingCode] = useState(false);
  const [verifyingCode, setVerifyingCode] = useState(false);
  const [phoneError, setPhoneError] = useState('');
  const [confirmationResult, setConfirmationResult] = useState<any>(null);
  const [recaptchaVerifier, setRecaptchaVerifier] = useState<any>(null);
  
  const { login } = useSocket();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password.trim()) return;

    setIsLoading(true);
    setError('');

    try {
      const resp = await login(password, otp.trim() || undefined, idToken);
      if (resp?.success) {
        return;
      }
      const requiresTotp = !!(resp?.data && (resp.data as any).requires_totp);
      const requiresPhone = !!(resp?.data && (resp.data as any).requires_phone);
      if (requiresTotp) {
        if (String(resp?.error || '').toLowerCase().includes('not enrolled')) {
          await handleEnroll();
          setError('Scan the QR and enter the OTP to sign in.');
        } else {
          setError('Enter the 6-digit OTP from your Auth-App.');
        }
      } else if (requiresPhone) {
        if (!idToken) {
          setError('Phone verification required. Send and verify SMS OTP.');
        } else {
          setError('Phone verification failed. Try again.');
        }
      } else {
        setError(resp?.error || 'Login failed. Check password or OTP.');
      }
    } catch (error) {
      setError('Login failed. Please check your connection and try again.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    (async () => {
      const res = await apiClient.getTotpStatus();
      if (res.success && res.data) {
        setTotpInfo(res.data);
      }
    })();
  }, []);

  const handleEnroll = async () => {
    if (!password.trim()) {
      setError('Enter admin password to enroll');
      return;
    }
    setEnrolling(true);
    setError('');
    try {
      const res = await apiClient.enrollTotp(password);
      if (res.success && res.data) {
        setSecret(res.data.secret);
        setQrB64(res.data.qr);
        setTotpInfo({ enabled: true, enrolled: true, issuer: (totpInfo?.issuer || 'Neural Control Hub') });
      } else {
        setError(res.error || 'Enrollment failed');
      }
    } catch {
      setError('Enrollment failed');
    } finally {
      setEnrolling(false);
    }
  };

  const ensureFirebaseAuth = () => {
    try {
      const apiKey = (import.meta as any)?.env?.VITE_FIREBASE_API_KEY;
      const authDomain = (import.meta as any)?.env?.VITE_FIREBASE_AUTH_DOMAIN;
      const projectId = (import.meta as any)?.env?.VITE_FIREBASE_PROJECT_ID;
      if (!apiKey || !authDomain || !projectId) {
        setPhoneError('Phone auth not configured');
        return null;
      }
      const app = getApps().length ? getApps()[0] : initializeApp({ apiKey, authDomain, projectId });
      const auth = getAuth(app);
      if (!recaptchaVerifier) {
        const verifier = new RecaptchaVerifier('recaptcha-container', { size: 'invisible' }, auth);
        setRecaptchaVerifier(verifier);
      }
      return auth;
    } catch (e: any) {
      setPhoneError(e?.message || 'Failed to initialize phone auth');
      return null;
    }
  };

  const handleSendSms = async () => {
    setPhoneError('');
    setSendingCode(true);
    try {
      const auth = ensureFirebaseAuth();
      if (!auth || !recaptchaVerifier) {
        setSendingCode(false);
        return;
      }
      const cr = await signInWithPhoneNumber(auth, phone, recaptchaVerifier);
      setConfirmationResult(cr);
    } catch (e: any) {
      setPhoneError(e?.message || 'Failed to send SMS code');
    } finally {
      setSendingCode(false);
    }
  };

  const handleVerifySms = async () => {
    if (!confirmationResult || !smsCode.trim()) {
      setPhoneError('Enter the received SMS code');
      return;
    }
    setVerifyingCode(true);
    setPhoneError('');
    try {
      const cred = await confirmationResult.confirm(smsCode.trim());
      const token = await cred.user.getIdToken();
      setIdToken(token);
    } catch (e: any) {
      setPhoneError(e?.message || 'Invalid SMS code');
    } finally {
      setVerifyingCode(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-4 text-center">
          <div className="mx-auto w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center">
            <Shield className="h-8 w-8 text-primary" />
          </div>
          <div>
            <CardTitle className="text-2xl font-bold">Neural Control Hub</CardTitle>
            <CardDescription className="text-base">
              Advanced Agent Management System
            </CardDescription>
          </div>
        </CardHeader>
        
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            
            <div className="space-y-2">
              <label htmlFor="password" className="text-sm font-medium">
                Admin Password
              </label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter admin password"
                  className="pr-10"
                  disabled={isLoading}
                  autoFocus
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="absolute right-0 top-0 h-full px-3 hover:bg-transparent"
                  onClick={() => setShowPassword(!showPassword)}
                  disabled={isLoading}
                >
                  {showPassword ? (
                    <EyeOff className="h-4 w-4 text-muted-foreground" />
                  ) : (
                    <Eye className="h-4 w-4 text-muted-foreground" />
                  )}
                </Button>
              </div>
            </div>
            
            <div className="space-y-2">
              <label htmlFor="otp" className="text-sm font-medium">
                Auth-App OTP
              </label>
              <Input
                id="otp"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="6-digit code"
                disabled={isLoading}
              />
              <div className="text-xs text-muted-foreground">
                {totpInfo?.enabled ? 'Two-factor authentication is enabled' : 'Two-factor authentication is optional'}
              </div>
            </div>
            
            <Button 
              type="submit" 
              className="w-full" 
              disabled={!password.trim() || isLoading}
            >
              {isLoading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Authenticating...
                </>
              ) : (
                'Sign In'
              )}
            </Button>
            
            <div className="mt-4 space-y-2">
              <div className="text-sm font-medium">Set up Auth-App (Google Authenticator)</div>
              <div className="text-xs text-muted-foreground">
                Scan the QR and enter OTP to sign in
              </div>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={handleEnroll}
                  disabled={enrolling || !password.trim()}
                >
                  {enrolling ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Generating QR...
                    </>
                  ) : (
                    'Generate QR'
                  )}
                </Button>
                {secret ? <div className="text-xs">Secret: {secret}</div> : null}
              </div>
              {qrB64 ? (
                <div className="mt-2 flex justify-center">
                  <img
                    src={`data:image/png;base64,${qrB64}`}
                    alt="Scan with Authenticator"
                    className="border rounded p-2"
                  />
                </div>
              ) : null}
            </div>

            <div className="mt-6 pt-6 border-t space-y-3">
              <div className="text-sm font-medium">Phone Number OTP</div>
              {phoneError ? (
                <Alert variant="destructive">
                  <AlertDescription>{phoneError}</AlertDescription>
                </Alert>
              ) : null}
              <Input
                id="phone"
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+639XXXXXXXXX"
                disabled={sendingCode || verifyingCode}
              />
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={handleSendSms}
                  disabled={sendingCode || verifyingCode || !phone.trim()}
                >
                  {sendingCode ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Sending...
                    </>
                  ) : (
                    'Send OTP'
                  )}
                </Button>
                {idToken ? <div className="text-xs text-green-600">Phone verified</div> : null}
              </div>
              <div className="flex items-center gap-2">
                <Input
                  id="smsCode"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={smsCode}
                  onChange={(e) => setSmsCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="SMS code"
                  disabled={verifyingCode}
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={handleVerifySms}
                  disabled={verifyingCode || !confirmationResult || !smsCode.trim()}
                >
                  {verifyingCode ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Verifying...
                    </>
                  ) : (
                    'Verify'
                  )}
                </Button>
              </div>
              <div id="recaptcha-container" />
            </div>
          </form>
          
          <div className="mt-6 pt-6 border-t text-center text-xs text-muted-foreground">
            <p>Secure authentication required</p>
            <p className="mt-1">Contact your administrator for access credentials</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
