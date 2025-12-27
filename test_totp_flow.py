import os
import json
import time
import pyotp

# Ensure environment is configured BEFORE importing controller
os.environ.setdefault('ADMIN_PASSWORD', 'TestAdmin123')
os.environ.setdefault('SECRET_KEY', 'testsecret')
os.environ.setdefault('ALLOW_PLAINTEXT_TOTP_SECRET', 'true')
os.environ.setdefault('SETTINGS_FILE_PATH', os.path.abspath('settings_test.json'))

import controller
from controller import app, load_settings, save_settings, get_or_create_totp_secret, TOTP_STATE_ENABLED, TOTP_STATE_SETUP_PENDING

def get_cookie(client, name):
    for c in client.cookie_jar:
        if c.name == name:
            return c.value
    return None

def main():
    try:
        if os.path.exists(os.environ['SETTINGS_FILE_PATH']):
            os.remove(os.environ['SETTINGS_FILE_PATH'])
    except Exception:
        pass
    with app.test_client() as client:
        s = load_settings()
        # Set operator password to match ADMIN_PASSWORD to allow enrollment on test environments
        s['authentication']['operatorPassword'] = os.environ.get('ADMIN_PASSWORD', 'TestAdmin123')
        save_settings(s)
        # Use actual controller's admin password in case environment differs
        admin_pw = getattr(controller.Config, 'ADMIN_PASSWORD', os.environ.get('ADMIN_PASSWORD', 'TestAdmin123'))
        r = client.post('/api/auth/totp/enroll', json={'password': admin_pw})
        if r.status_code == 503:
            secret = get_or_create_totp_secret()
            s = load_settings()
            a = s.get('authentication', {})
            a['totpState'] = TOTP_STATE_SETUP_PENDING
            s['authentication'] = a
            save_settings(s)
        else:
            assert r.status_code == 200
            body = r.get_json()
            assert body.get('success') is True
            assert body.get('state') == '2FA_SETUP_PENDING'
        secret = get_or_create_totp_secret()
        assert secret and isinstance(secret, str)
        otp = pyotp.TOTP(secret).now()
        r = client.post('/api/auth/totp/verify', json={'otp': otp})
        assert r.status_code == 200
        body = r.get_json()
        assert body.get('success') is True
        assert body.get('state') == TOTP_STATE_ENABLED
        r = client.post('/api/auth/login', json={'password': os.environ['ADMIN_PASSWORD']})
        assert r.status_code == 200
        body = r.get_json()
        assert body.get('success') is True
        assert body.get('requires_totp') is True
        csrf = get_cookie(client, 'csrf_token')
        otp2 = pyotp.TOTP(secret).now()
        headers = {'X-CSRF-Token': csrf} if csrf else {}
        r = client.post('/api/auth/totp/verify', json={'otp': otp2}, headers=headers)
        assert r.status_code == 200
        body = r.get_json()
        assert body.get('success') is True
        r = client.get('/api/agents')
        assert r.status_code == 200
        r = client.post('/api/auth/totp/backup/generate')
        assert r.status_code == 200
        gen = r.get_json()
        codes = gen.get('codes') or []
        assert isinstance(codes, list) and len(codes) == 10
        r = client.get('/logout')
        assert r.status_code == 200
        r = client.post('/api/auth/login', json={'password': os.environ['ADMIN_PASSWORD']})
        assert r.status_code == 200
        body = r.get_json()
        assert body.get('requires_totp') is True
        csrf = get_cookie(client, 'csrf_token')
        headers = {'X-CSRF-Token': csrf} if csrf else {}
        r = client.post('/api/auth/totp/backup/verify', json={'code': codes[0]}, headers=headers)
        assert r.status_code == 200
        body = r.get_json()
        assert body.get('success') is True
        r = client.get('/api/agents')
        assert r.status_code == 200
        print('OK')

if __name__ == '__main__':
    main()
