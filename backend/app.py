"""
CandyBlast サーバー (Python / Flask 版)
元は Node.js / Express で書かれていた server.js を、機能・挙動をできるだけ
そのまま保ったうえで Python に移植したものです。
フロントエンド(index.html / styles.css / script.js)は変更していません。
"""
import os
import re
import json
import base64
import random
import string
import secrets
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import jwt
import bcrypt
import requests
from flask import Flask, request, jsonify
from flask_cors import CORS
from psycopg2 import pool as pg_pool
from psycopg2.extras import RealDictCursor
from apscheduler.schedulers.background import BackgroundScheduler

# ===================== 基本設定 =====================
app = Flask(__name__)
CORS(app)

DATABASE_URL = os.environ.get('DATABASE_URL')
JWT_SECRET = os.environ.get('JWT_SECRET', 'your-secret-key')

DISCORD_WEBHOOK_AUTH = os.environ.get('DISCORD_WEBHOOK_AUTH', '')
DISCORD_WEBHOOK_LOGIN = os.environ.get('DISCORD_WEBHOOK_LOGIN', '')
DISCORD_WEBHOOK_FEATURE_REQUEST = os.environ.get(
    'DISCORD_WEBHOOK_FEATURE_REQUEST',
    'https://discord.com/api/webhooks/1546488875810164736/gLYm0_WRcHPplCzzTPQopBc4t0O5QqLmQx8q4MOZN9qQHjETpmwmi0jRHMgEWlQVPRC3'
)
DISCORD_WEBHOOK_BUG_REPORT = os.environ.get(
    'DISCORD_WEBHOOK_BUG_REPORT',
    'https://discord.com/api/webhooks/1546490249239334943/LTkNUk1oAk3jERMQRZMY9J5P9LaF7LbR2566ngGxJrct-OK7r0XTHnIcFvfaQi_641SD'
)

if not DATABASE_URL:
    print('❌ 環境変数 DATABASE_URL が設定されていません。RenderのEnvironmentタブで設定してください。')

# ===================== DB接続プール =====================
# Node版の pg.Pool 相当。Renderのマネージド Postgres は自己署名証明書を使うため
# sslmode='require' を指定する(証明書の検証はしない = 元のNode版の rejectUnauthorized:false と同等)。
_pool = None
if DATABASE_URL:
    _pool = pg_pool.ThreadedConnectionPool(1, 20, dsn=DATABASE_URL, sslmode='require')


def db_query(sql, params=None, fetch=True):
    """psycopg2で1クエリを実行するショートカット。SELECT系はdictのリストを返す。"""
    conn = _pool.getconn()
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(sql, params or [])
            rows = cur.fetchall() if (fetch and cur.description is not None) else []
            conn.commit()
            return rows
    except Exception:
        conn.rollback()
        raise
    finally:
        _pool.putconn(conn)


def db_execute(sql, params=None):
    db_query(sql, params, fetch=False)


# ===================== Discord通知 =====================
def send_discord_notification(webhook_url, title, description, color=0x5865F2,
                               fields=None, image_bytes=None, image_filename='image.png',
                               image_mime_type='image/png'):
    """埋め込みメッセージ(必要なら画像添付)をDiscordのWebhookへ送信する。成功したかをboolで返す。"""
    if not webhook_url:
        return False
    fields = fields or []
    embed = {
        'title': title, 'description': description, 'color': color,
        'timestamp': datetime.utcnow().isoformat() + 'Z',
        'fields': fields, 'footer': {'text': 'CandyBlast System'}
    }
    try:
        if image_bytes:
            # payload_json側に attachments 配列で「どのファイルがどのattachment idか」を
            # 明示しないと、画像がDiscordに届かない/無視されることがある。
            embed['image'] = {'url': f'attachment://{image_filename}'}
            payload = {'embeds': [embed], 'attachments': [{'id': 0, 'filename': image_filename}]}
            files = {'files[0]': (image_filename, image_bytes, image_mime_type)}
            resp = requests.post(webhook_url, data={'payload_json': json.dumps(payload)}, files=files, timeout=15)
        else:
            resp = requests.post(webhook_url, json={'embeds': [embed]}, timeout=15)
        if resp.status_code >= 300:
            print(f'Discord通知失敗: HTTP {resp.status_code} {resp.text}')
            return False
        return True
    except Exception as err:
        print(f'Discord通知失敗: {err}')
        return False


# ===================== 認証ヘルパー =====================
class ApiError(Exception):
    def __init__(self, message, status=500):
        super().__init__(message)
        self.message = message
        self.status = status


def make_token(user_id):
    payload = {'id': user_id, 'exp': datetime.utcnow() + timedelta(days=7)}
    return jwt.encode(payload, JWT_SECRET, algorithm='HS256')


def get_token_from_request():
    auth = request.headers.get('Authorization', '')
    if auth.startswith('Bearer '):
        return auth[len('Bearer '):]
    return None


def require_auth():
    token = get_token_from_request()
    if not token:
        raise ApiError('認証が必要です', 401)
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=['HS256'])
        return payload['id']
    except Exception:
        raise ApiError('認証エラー', 401)


def get_user_id_optional():
    token = get_token_from_request()
    if not token:
        return 'ゲスト'
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=['HS256'])['id']
    except Exception:
        return 'ゲスト'


def are_friends(a, b):
    rows = db_query('SELECT 1 FROM friends WHERE user_id = %s AND friend_id = %s', [a, b])
    return len(rows) > 0


def generate_recovery_code():
    parts = []
    for _ in range(4):
        chars = string.ascii_uppercase + string.digits
        parts.append(''.join(secrets.choice(chars) for _ in range(4)))
    return '-'.join(parts)


def hash_password(password):
    return bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt(10)).decode('utf-8')


def check_password(password, hashed):
    try:
        return bcrypt.checkpw(password.encode('utf-8'), hashed.encode('utf-8'))
    except Exception:
        return False


# ===================== テーブル作成(起動時に順番に実行) =====================
# Node版と同じく、CREATE TABLE IF NOT EXISTS は既存テーブルには効かないため、
# 後から追加した列は必ず ALTER TABLE ... ADD COLUMN IF NOT EXISTS で追加する。
def init_db():
    db_execute("""
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            password_hash TEXT NOT NULL,
            recovery_code TEXT,
            recovery_code_used BOOLEAN DEFAULT FALSE,
            best_score INTEGER DEFAULT 0,
            coins INTEGER DEFAULT 0,
            skins TEXT DEFAULT '["default"]',
            equipped_skin TEXT DEFAULT 'default',
            quests TEXT DEFAULT '[]',
            last_login TIMESTAMP,
            created_at TIMESTAMP DEFAULT NOW()
        );
    """)
    db_execute("""
        ALTER TABLE users ADD COLUMN IF NOT EXISTS best_scores JSONB DEFAULT '{}';
        ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_settings JSONB DEFAULT '{"disabledBlocks":[],"safetyMode":false}';
        ALTER TABLE users ADD COLUMN IF NOT EXISTS quest_progress JSONB DEFAULT '{}';
        ALTER TABLE users ADD COLUMN IF NOT EXISTS banned BOOLEAN DEFAULT FALSE;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS play_time INTEGER DEFAULT 0;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active TIMESTAMP;
        ALTER TABLE users ALTER COLUMN coins TYPE BIGINT;
        ALTER TABLE users ALTER COLUMN best_score TYPE BIGINT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS gacha_state JSONB DEFAULT '{"totalPulls":0,"pityCounter":0}';
        ALTER TABLE users ADD COLUMN IF NOT EXISTS battlepass_xp INTEGER DEFAULT 0;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS battlepass_claimed JSONB DEFAULT '[]';
        ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_forced_scores JSONB DEFAULT '{}';
    """)
    print('✅ users テーブル準備完了')

    db_execute("""
        CREATE TABLE IF NOT EXISTS chat_messages (
            id SERIAL PRIMARY KEY, user_id TEXT NOT NULL, message TEXT NOT NULL,
            timestamp TIMESTAMP DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_chat_timestamp ON chat_messages(timestamp);
    """)
    print('✅ チャットテーブル作成完了')

    db_execute("""
        CREATE TABLE IF NOT EXISTS friend_requests (
            id SERIAL PRIMARY KEY, from_id TEXT NOT NULL, to_id TEXT NOT NULL,
            status TEXT DEFAULT 'pending', created_at TIMESTAMP DEFAULT NOW(),
            UNIQUE(from_id, to_id)
        );
        CREATE TABLE IF NOT EXISTS friends (
            id SERIAL PRIMARY KEY, user_id TEXT NOT NULL, friend_id TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT NOW(), UNIQUE(user_id, friend_id)
        );
        CREATE TABLE IF NOT EXISTS dm_messages (
            id SERIAL PRIMARY KEY, from_id TEXT NOT NULL, to_id TEXT NOT NULL,
            message TEXT NOT NULL, is_read BOOLEAN DEFAULT FALSE, timestamp TIMESTAMP DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_dm_pair ON dm_messages(from_id, to_id);
    """)
    print('✅ フレンド／DMテーブル作成完了')

    db_execute("""
        CREATE TABLE IF NOT EXISTS announcements (
            id SERIAL PRIMARY KEY, message TEXT NOT NULL, created_at TIMESTAMP DEFAULT NOW()
        );
    """)
    print('✅ お知らせテーブル作成完了')

    db_execute("""
        CREATE TABLE IF NOT EXISTS duels (
            id SERIAL PRIMARY KEY, challenger_id TEXT NOT NULL, opponent_id TEXT NOT NULL,
            status TEXT DEFAULT 'pending', duration INTEGER DEFAULT 60,
            challenger_score INTEGER, opponent_score INTEGER, created_at TIMESTAMP DEFAULT NOW()
        );
    """)
    print('✅ 対決(デュエル)テーブル作成完了')

    db_execute("""
        CREATE TABLE IF NOT EXISTS scheduled_events (
            id SERIAL PRIMARY KEY, hour_jst INTEGER NOT NULL, ranking_mode TEXT NOT NULL,
            rank_position INTEGER NOT NULL, reward_coins INTEGER NOT NULL,
            last_triggered_date TEXT, created_at TIMESTAMP DEFAULT NOW()
        );
    """)
    db_execute("""
        ALTER TABLE scheduled_events ADD COLUMN IF NOT EXISTS recurrence TEXT DEFAULT 'daily';
        ALTER TABLE scheduled_events ADD COLUMN IF NOT EXISTS minute_jst INTEGER DEFAULT 0;
        ALTER TABLE scheduled_events ADD COLUMN IF NOT EXISTS event_year INTEGER;
        ALTER TABLE scheduled_events ADD COLUMN IF NOT EXISTS event_month INTEGER;
        ALTER TABLE scheduled_events ADD COLUMN IF NOT EXISTS event_day INTEGER;
    """)
    print('✅ スケジュールイベントテーブル作成完了')

    db_execute("""
        CREATE TABLE IF NOT EXISTS weekly_challenge (
            id SERIAL PRIMARY KEY, week_key TEXT UNIQUE NOT NULL, mode TEXT NOT NULL,
            size INTEGER NOT NULL, created_at TIMESTAMP DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS weekly_challenge_scores (
            id SERIAL PRIMARY KEY, week_key TEXT NOT NULL, user_id TEXT NOT NULL,
            score INTEGER NOT NULL, created_at TIMESTAMP DEFAULT NOW(),
            UNIQUE(week_key, user_id)
        );
    """)
    print('✅ 週替わりチャレンジテーブル作成完了')


# ===================== 日本時間(JST)ヘルパー =====================
JST = ZoneInfo('Asia/Tokyo')


def jst_now():
    return datetime.now(JST)


def jst_date_key(d):
    return f'{d.year}-{d.month:02d}-{d.day:02d}'


# ===================== ガチャ・バトルパスの定数 =====================
GACHA_SKIN_IDS = [
    'gacha_cosmicdragon', 'gacha_celestialphoenix', 'gacha_voidempress',
    'gacha_abyssleviathan', 'gacha_thunderlord', 'gacha_celestialblossom',
]
GACHA_SKIN_ID_SET = set(GACHA_SKIN_IDS)
GACHA_COST = 300
GACHA_RATE_PER_SKIN = 0.02
GACHA_PITY_THRESHOLD = 50
GACHA_DUPLICATE_COINS = 500
GACHA_MISS_COINS = 30

BATTLEPASS_XP_PER_LEVEL = 1000
BATTLEPASS_CYCLE_LENGTH = 10
WEEKLY_CHALLENGE_REWARD = 1500


def battle_pass_reward_for_level(level):
    cycle_pos = ((level - 1) % BATTLEPASS_CYCLE_LENGTH) + 1
    rewards = {
        1: {'type': 'coins', 'amount': 100}, 2: {'type': 'coins', 'amount': 150},
        3: {'type': 'coins', 'amount': 200}, 4: {'type': 'coins', 'amount': 250},
        5: {'type': 'gacha_ticket', 'amount': 1}, 6: {'type': 'coins', 'amount': 300},
        7: {'type': 'coins', 'amount': 350}, 8: {'type': 'coins', 'amount': 400},
        9: {'type': 'coins', 'amount': 500}, 10: {'type': 'gacha_ticket', 'amount': 1},
    }
    r = dict(rewards[cycle_pos])
    r['level'] = level
    return r


# ===================== 共通エラーハンドラ =====================
@app.errorhandler(ApiError)
def handle_api_error(err):
    return jsonify({'error': err.message}), err.status


# ===================== ユーザー登録 =====================
@app.post('/api/register')
def register():
    body = request.get_json(silent=True) or {}
    user_id = body.get('id')
    password = body.get('password')
    if not user_id or not password or len(password) < 6:
        return jsonify({'error': 'IDとパスワード(6文字以上)が必要です'}), 400
    if not re.match(r'^[a-zA-Z0-9_]{3,20}$', user_id):
        return jsonify({'error': 'IDは半角英数字とアンダースコアで3〜20文字です'}), 400
    try:
        if db_query('SELECT * FROM users WHERE id = %s', [user_id]):
            return jsonify({'error': 'このIDは既に使われています'}), 400
        pw_hash = hash_password(password)
        recovery_code = generate_recovery_code()
        db_execute(
            'INSERT INTO users (id, password_hash, recovery_code, recovery_code_used) VALUES (%s, %s, %s, %s)',
            [user_id, pw_hash, recovery_code, False]
        )
        token = make_token(user_id)
        send_discord_notification(
            DISCORD_WEBHOOK_AUTH, '📝 新規ユーザー登録', f'ユーザー **{user_id}** が新規登録しました！', 0x00FF00,
            [{'name': '🔑 復元コード', 'value': f'`{recovery_code}`', 'inline': False},
             {'name': '📅 登録日時', 'value': datetime.now().strftime('%Y/%m/%d %H:%M:%S'), 'inline': True}]
        )
        return jsonify({'token': token, 'id': user_id, 'recoveryCode': recovery_code})
    except Exception as err:
        print(err)
        return jsonify({'error': 'サーバーエラー'}), 500


# ===================== ログイン =====================
@app.post('/api/login')
def login():
    body = request.get_json(silent=True) or {}
    user_id = body.get('id')
    password = body.get('password')
    try:
        rows = db_query('SELECT * FROM users WHERE id = %s', [user_id])
        if not rows:
            return jsonify({'error': 'IDまたはパスワードが間違っています'}), 401
        user = rows[0]
        if user.get('banned'):
            return jsonify({'error': 'このアカウントはBANされています'}), 403
        if not password or not check_password(password, user['password_hash']):
            return jsonify({'error': 'IDまたはパスワードが間違っています'}), 401
        db_execute('UPDATE users SET last_login = NOW() WHERE id = %s', [user_id])
        token = make_token(user_id)
        send_discord_notification(
            DISCORD_WEBHOOK_LOGIN, '🔐 ログイン検出', f'ユーザー **{user_id}** がログインしました。', 0x5865F2,
            [{'name': '🕐 ログイン日時', 'value': datetime.now().strftime('%Y/%m/%d %H:%M:%S'), 'inline': True},
             {'name': '🏆 現在のベストスコア', 'value': f"{user.get('best_score') or 0}点", 'inline': True}]
        )
        return jsonify({
            'token': token, 'id': user_id,
            'bestScore': user.get('best_score'), 'bestScores': user.get('best_scores') or {},
            'coins': int(user.get('coins') or 0), 'playTime': user.get('play_time') or 0,
            'lastLogin': user.get('last_login').isoformat() if user.get('last_login') else None
        })
    except Exception as err:
        print(err)
        return jsonify({'error': 'サーバーエラー'}), 500


# ===================== パスワード復元 =====================
@app.post('/api/recover')
def recover():
    body = request.get_json(silent=True) or {}
    user_id = body.get('id')
    recovery_code = body.get('recoveryCode')
    new_password = body.get('newPassword')
    if not new_password or len(new_password) < 6:
        return jsonify({'error': '新しいパスワードは6文字以上が必要です'}), 400
    try:
        rows = db_query(
            'SELECT * FROM users WHERE id = %s AND recovery_code = %s AND recovery_code_used = false',
            [user_id, recovery_code]
        )
        if not rows:
            return jsonify({'error': '無効な復元コードです（既に使われたか期限切れです）'}), 400
        pw_hash = hash_password(new_password)
        new_recovery_code = generate_recovery_code()
        db_execute(
            'UPDATE users SET password_hash = %s, recovery_code = %s, recovery_code_used = false WHERE id = %s',
            [pw_hash, new_recovery_code, user_id]
        )
        send_discord_notification(
            DISCORD_WEBHOOK_AUTH, '🔄 パスワード再設定', f'ユーザー **{user_id}** のパスワードが再設定されました。', 0xFFA500,
            [{'name': '🆕 新しい復元コード', 'value': f'`{new_recovery_code}`', 'inline': False},
             {'name': '⚠️ 注意', 'value': 'このコードは使い捨てです。次回再設定時に再発行されます。', 'inline': False}]
        )
        return jsonify({'success': True, 'message': 'パスワードを再設定しました。', 'newRecoveryCode': new_recovery_code})
    except Exception as err:
        print(err)
        return jsonify({'error': 'サーバーエラー'}), 500


# ===================== 復元コード再発行 =====================
@app.post('/api/renew-recovery')
def renew_recovery():
    body = request.get_json(silent=True) or {}
    user_id = body.get('id')
    if not user_id:
        return jsonify({'error': 'IDが必要です'}), 400
    try:
        if not db_query('SELECT * FROM users WHERE id = %s', [user_id]):
            return jsonify({'error': 'ユーザーが見つかりません'}), 404
        new_recovery_code = generate_recovery_code()
        db_execute('UPDATE users SET recovery_code = %s, recovery_code_used = false WHERE id = %s',
                   [new_recovery_code, user_id])
        send_discord_notification(
            DISCORD_WEBHOOK_AUTH, '🔑 復元コード再発行', f'ユーザー **{user_id}** の復元コードが再発行されました。', 0x9B59B6,
            [{'name': '🆕 新しい復元コード', 'value': f'`{new_recovery_code}`', 'inline': False}]
        )
        return jsonify({'success': True, 'recoveryCode': new_recovery_code})
    except Exception as err:
        print(err)
        return jsonify({'error': 'サーバーエラー'}), 500


# ===================== データ同期 =====================
@app.post('/api/sync')
def sync_post():
    token = get_token_from_request()
    if not token:
        return jsonify({'error': '認証が必要です'}), 401
    try:
        user_id = jwt.decode(token, JWT_SECRET, algorithms=['HS256'])['id']
    except Exception:
        return jsonify({'error': '認証エラー'}), 401
    try:
        body = request.get_json(silent=True) or {}
        best_score = body.get('bestScore')
        coins = body.get('coins')
        skins = body.get('skins')
        equipped_skin = body.get('equippedSkin')
        quests = body.get('quests')
        mode = body.get('mode')
        play_time = body.get('playTime')

        update_fields = []
        values = []

        # 以前は「size===8のときだけ保存」という条件があり、8×8以外の盤面サイズで遊んだ
        # soft/baked/hardモードのスコアがサーバーに一切保存されないバグがあった。

# フロントから「これは実際にプレイした結果だよ」という印（fromPlay）が来る。
        # 管理者コマンドで入れた仮のスコアは、この印が来たときだけ上書きを許可する。
        from_play = bool(body.get('fromPlay'))
        if mode and best_score is not None:
            rows = db_query('SELECT best_scores, best_score, admin_forced_scores FROM users WHERE id = %s', [user_id])
            best_scores = (rows[0]['best_scores'] if rows else None) or {}
            forced = (rows[0].get('admin_forced_scores') if rows else None) or {}
            if from_play and forced.get(mode):
                # 管理者が /setscore で入れた値は「1回だけ有効」。
                # 実際のプレイ結果が届いたら、それを正として上書きし、フタを外す。
                best_scores[mode] = best_score
                forced.pop(mode, None)
                update_fields.append('best_scores = %s')
                values.append(json.dumps(best_scores))
                update_fields.append('admin_forced_scores = %s')
                values.append(json.dumps(forced))
            elif not best_scores.get(mode) or best_score > best_scores[mode]:
                best_scores[mode] = best_score
                update_fields.append('best_scores = %s')
                values.append(json.dumps(best_scores))
            if best_score > 0:
                current_best = (rows[0].get('best_score') if rows else 0) or 0
                if best_score > current_best:
                    update_fields.append('best_score = %s')
                    values.append(best_score)

        if coins is not None:
            update_fields.append('coins = %s')
            values.append(coins or 0)
        if skins is not None:
            existing_rows = db_query('SELECT skins FROM users WHERE id = %s', [user_id])
            existing_skins = json.loads((existing_rows[0]['skins'] if existing_rows else None) or '["default"]')
            safe_skins = [s for s in (skins if isinstance(skins, list) else [])
                          if s in existing_skins or s not in GACHA_SKIN_ID_SET]
            update_fields.append('skins = %s')
            values.append(json.dumps(safe_skins))
        if equipped_skin is not None:
            update_fields.append('equipped_skin = %s')
            values.append(equipped_skin or 'default')
        if quests is not None:
            update_fields.append('quests = %s')
            values.append(json.dumps(quests or []))
        if play_time is not None:
            update_fields.append('play_time = %s')
            values.append(play_time or 0)

        if not update_fields:
            rows = db_query('SELECT best_scores, coins FROM users WHERE id = %s', [user_id])
            return jsonify({'success': True,
                            'bestScores': (rows[0]['best_scores'] if rows else None) or {},
                            'coins': int((rows[0]['coins'] if rows else 0) or 0)})
        values.append(user_id)
        query = f"UPDATE users SET {', '.join(update_fields)} WHERE id = %s"
        db_execute(query, values)
        rows = db_query('SELECT best_scores, coins FROM users WHERE id = %s', [user_id])
        return jsonify({'success': True,
                        'bestScores': (rows[0]['best_scores'] if rows else None) or {},
                        'coins': int((rows[0]['coins'] if rows else 0) or 0)})
    except Exception as err:
        print(err)
        return jsonify({'error': '認証エラー'}), 401


@app.get('/api/sync')
def sync_get():
    token = get_token_from_request()
    if not token:
        return jsonify({'error': '認証が必要です'}), 401
    try:
        user_id = jwt.decode(token, JWT_SECRET, algorithms=['HS256'])['id']
        try:
            db_execute('UPDATE users SET last_active = NOW() WHERE id = %s', [user_id])
        except Exception:
            pass
        rows = db_query('SELECT * FROM users WHERE id = %s', [user_id])
        if not rows:
            return jsonify({'error': 'ユーザーが見つかりません'}), 404
        user = rows[0]
        return jsonify({
            'bestScore': user.get('best_score'), 'bestScores': user.get('best_scores') or {},
            'coins': int(user.get('coins') or 0), 'playTime': user.get('play_time') or 0,
            'skins': json.loads(user.get('skins') or '["default"]'),
            'equippedSkin': user.get('equipped_skin') or 'default',
            'quests': json.loads(user.get('quests') or '[]')
        })
    except Exception:
        return jsonify({'error': '認証エラー'}), 401


# ===================== ランキング =====================
@app.get('/api/ranking')
def ranking():
    mode = request.args.get('mode', 'soft')
    rtype = request.args.get('type', 'score')
    try:
        if rtype == 'playtime':
            top_query = 'SELECT id, play_time AS value FROM users WHERE play_time IS NOT NULL AND play_time > 0 ORDER BY play_time DESC LIMIT 50'
            count_query = 'SELECT COUNT(*) AS count FROM users WHERE play_time IS NOT NULL AND play_time > 0'
        else:
            valid_modes = ['soft', 'baked', 'hard', 'extreme', 'tetris', 'timeattack']
            if mode not in valid_modes:
                mode = 'soft'
            top_query = f"""
                SELECT id, best_scores->>'{mode}' AS value FROM users
                WHERE best_scores->>'{mode}' IS NOT NULL AND best_scores->>'{mode}' != '0'
                ORDER BY (best_scores->>'{mode}')::bigint DESC LIMIT 50
            """
            count_query = f"SELECT COUNT(*) AS count FROM users WHERE best_scores->>'{mode}' IS NOT NULL AND best_scores->>'{mode}' != '0'"
        top_rows = db_query(top_query)
        count_rows = db_query(count_query)
        top = [{'id': r['id'], 'value': int(r['value'])} for r in top_rows]
        return jsonify({'top': top, 'totalUsers': int(count_rows[0]['count'])})
    except Exception as err:
        print(err)
        return jsonify({'error': 'ランキング取得エラー'}), 500


# ===================== 🆕 ガチャ(限定スキン、低確率、天井あり) =====================
@app.get('/api/gacha/state')
def gacha_state():
    try:
        user_id = require_auth()
        rows = db_query('SELECT coins, gacha_state, skins FROM users WHERE id = %s', [user_id])
        if not rows:
            raise ApiError('ユーザーが見つかりません', 404)
        u = rows[0]
        gs = u.get('gacha_state') or {'totalPulls': 0, 'pityCounter': 0}
        return jsonify({
            'coins': int(u.get('coins') or 0), 'totalPulls': gs.get('totalPulls', 0),
            'pityCounter': gs.get('pityCounter', 0), 'pityThreshold': GACHA_PITY_THRESHOLD,
            'cost': GACHA_COST, 'freeTickets': gs.get('freeTickets', 0),
            'ownedSkins': json.loads(u.get('skins') or '["default"]')
        })
    except ApiError as e:
        return jsonify({'error': e.message}), e.status
    except Exception as err:
        return jsonify({'error': str(err) or 'サーバーエラー'}), 500


@app.post('/api/gacha/pull')
def gacha_pull():
    try:
        user_id = require_auth()
        rows = db_query('SELECT coins, gacha_state, skins FROM users WHERE id = %s', [user_id])
        if not rows:
            raise ApiError('ユーザーが見つかりません', 404)
        u = rows[0]
        coins = int(u.get('coins') or 0)
        gs = u.get('gacha_state') or {'totalPulls': 0, 'pityCounter': 0}
        owned_skins = json.loads(u.get('skins') or '["default"]')

        has_free_ticket = (gs.get('freeTickets') or 0) > 0
        if not has_free_ticket and coins < GACHA_COST:
            raise ApiError('コインが足りません', 400)
        if has_free_ticket:
            gs['freeTickets'] = (gs.get('freeTickets') or 0) - 1
        else:
            coins -= GACHA_COST

        gs['totalPulls'] = (gs.get('totalPulls') or 0) + 1
        gs['pityCounter'] = (gs.get('pityCounter') or 0) + 1

        roll = random.random()
        natural_win = roll < GACHA_RATE_PER_SKIN * len(GACHA_SKIN_IDS)
        pity_win = (not natural_win) and gs['pityCounter'] >= GACHA_PITY_THRESHOLD
        won_skin_id = random.choice(GACHA_SKIN_IDS) if (natural_win or pity_win) else None

        result_type = 'miss'
        coins_gained = 0
        skin_id = None
        if won_skin_id:
            gs['pityCounter'] = 0
            skin_id = won_skin_id
            if won_skin_id in owned_skins:
                result_type = 'duplicate'
                coins_gained = GACHA_DUPLICATE_COINS
                coins += GACHA_DUPLICATE_COINS
            else:
                result_type = 'win'
                owned_skins.append(won_skin_id)
        else:
            coins_gained = GACHA_MISS_COINS
            coins += GACHA_MISS_COINS

        db_execute('UPDATE users SET coins=%s, gacha_state=%s, skins=%s WHERE id=%s',
                   [coins, json.dumps(gs), json.dumps(owned_skins), user_id])
        return jsonify({
            'resultType': result_type, 'skinId': skin_id, 'coinsGained': coins_gained,
            'pityTriggered': pity_win, 'usedFreeTicket': has_free_ticket, 'coins': coins,
            'totalPulls': gs['totalPulls'], 'pityCounter': gs['pityCounter'],
            'pityThreshold': GACHA_PITY_THRESHOLD, 'freeTickets': gs.get('freeTickets', 0),
            'ownedSkins': owned_skins
        })
    except ApiError as e:
        return jsonify({'error': e.message}), e.status
    except Exception as err:
        return jsonify({'error': str(err) or 'サーバーエラー'}), 500


# ===================== 🆕 バトルパス(経験値でレベルアップ、報酬はループ、上限なし) =====================
@app.get('/api/battlepass/state')
def battlepass_state():
    try:
        user_id = require_auth()
        rows = db_query('SELECT battlepass_xp, battlepass_claimed FROM users WHERE id = %s', [user_id])
        if not rows:
            raise ApiError('ユーザーが見つかりません', 404)
        xp = rows[0].get('battlepass_xp') or 0
        claimed = rows[0].get('battlepass_claimed') or []
        level = xp // BATTLEPASS_XP_PER_LEVEL + 1
        xp_into_level = xp % BATTLEPASS_XP_PER_LEVEL
        rewards = [dict(battle_pass_reward_for_level(lv), claimed=(lv in claimed)) for lv in range(1, level + 1)]
        return jsonify({'xp': xp, 'level': level, 'xpIntoLevel': xp_into_level,
                        'xpPerLevel': BATTLEPASS_XP_PER_LEVEL, 'rewards': rewards})
    except ApiError as e:
        return jsonify({'error': e.message}), e.status
    except Exception as err:
        return jsonify({'error': str(err) or 'サーバーエラー'}), 500


@app.post('/api/battlepass/addxp')
def battlepass_addxp():
    try:
        user_id = require_auth()
        body = request.get_json(silent=True) or {}
        add_amount = max(0, min(5000, int(body.get('amount') or 0)))
        db_execute('UPDATE users SET battlepass_xp = battlepass_xp + %s WHERE id = %s', [add_amount, user_id])
        return jsonify({'ok': True})
    except ApiError as e:
        return jsonify({'error': e.message}), e.status
    except Exception as err:
        return jsonify({'error': str(err) or 'サーバーエラー'}), 500


@app.post('/api/battlepass/claim')
def battlepass_claim():
    try:
        user_id = require_auth()
        body = request.get_json(silent=True) or {}
        lv = int(body.get('level') or 0)
        if lv < 1:
            raise ApiError('レベルを指定してください', 400)
        rows = db_query('SELECT coins, battlepass_xp, battlepass_claimed, gacha_state FROM users WHERE id = %s', [user_id])
        if not rows:
            raise ApiError('ユーザーが見つかりません', 404)
        u = rows[0]
        current_level = (u.get('battlepass_xp') or 0) // BATTLEPASS_XP_PER_LEVEL + 1
        if lv > current_level:
            raise ApiError('まだそのレベルに到達していません', 400)
        claimed = u.get('battlepass_claimed') or []
        if lv in claimed:
            raise ApiError('すでに受け取り済みです', 400)
        reward = battle_pass_reward_for_level(lv)
        coins = int(u.get('coins') or 0)
        gs = u.get('gacha_state') or {'totalPulls': 0, 'pityCounter': 0}
        free_tickets = gs.get('freeTickets') or 0
        if reward['type'] == 'coins':
            coins += reward['amount']
        elif reward['type'] == 'gacha_ticket':
            free_tickets += reward['amount']
            gs['freeTickets'] = free_tickets
        claimed.append(lv)
        db_execute('UPDATE users SET coins=%s, battlepass_claimed=%s, gacha_state=%s WHERE id=%s',
                   [coins, json.dumps(claimed), json.dumps(gs), user_id])
        return jsonify({'ok': True, 'reward': reward, 'coins': coins, 'freeTickets': free_tickets})
    except ApiError as e:
        return jsonify({'error': e.message}), e.status
    except Exception as err:
        return jsonify({'error': str(err) or 'サーバーエラー'}), 500


# ===================== 🆕 スケジュールイベント(自動報酬) =====================
def compute_next_trigger(e, now):
    next_dt = now.replace(second=0, microsecond=0)
    recurrence = e['recurrence']
    if recurrence == 'once':
        try:
            next_dt = next_dt.replace(year=e['event_year'], month=e['event_month'], day=e['event_day'],
                                       hour=e['hour_jst'], minute=e['minute_jst'] or 0)
        except Exception:
            return None
        return next_dt if next_dt > now else None
    if recurrence == 'daily':
        next_dt = next_dt.replace(hour=e['hour_jst'], minute=e['minute_jst'] or 0)
        if next_dt <= now:
            next_dt += timedelta(days=1)
        return next_dt
    if recurrence == 'weekly':
        next_dt = next_dt.replace(hour=e['hour_jst'], minute=e['minute_jst'] or 0)
        target_dow_js = e['event_day']
        current_dow_js = (now.weekday() + 1) % 7
        diff = (target_dow_js - current_dow_js + 7) % 7
        if diff == 0 and next_dt <= now:
            diff = 7
        next_dt += timedelta(days=diff)
        return next_dt
    if recurrence == 'monthly':
        try:
            next_dt = next_dt.replace(day=e['event_day'], hour=e['hour_jst'], minute=e['minute_jst'] or 0)
        except Exception:
            return None
        if next_dt <= now:
            if next_dt.month == 12:
                next_dt = next_dt.replace(year=next_dt.year + 1, month=1)
            else:
                next_dt = next_dt.replace(month=next_dt.month + 1)
        return next_dt
    return None


@app.get('/api/events/list')
def events_list():
    try:
        rows = db_query('SELECT * FROM scheduled_events ORDER BY id')
        now = jst_now()
        events = []
        for e in rows:
            next_dt = compute_next_trigger(e, now)
            if next_dt is None:
                continue
            events.append({
                'id': e['id'], 'recurrence': e['recurrence'], 'hourJst': e['hour_jst'],
                'minuteJst': e.get('minute_jst') or 0, 'eventYear': e.get('event_year'),
                'eventMonth': e.get('event_month'), 'eventDay': e.get('event_day'),
                'rankingMode': e['ranking_mode'], 'rankPosition': e['rank_position'],
                'rewardCoins': e['reward_coins'],
                'secondsUntilNext': round((next_dt - now).total_seconds())
            })
        return jsonify({'events': events})
    except Exception:
        return jsonify({'events': []})


def run_event_scheduler():
    try:
        now = jst_now()
        hour, minute = now.hour, now.minute
        date_key = jst_date_key(now)
        rows = db_query('SELECT * FROM scheduled_events WHERE hour_jst = %s AND minute_jst = %s', [hour, minute])
        for ev in rows:
            recurrence = ev['recurrence']
            should_fire = False
            if recurrence == 'once':
                should_fire = (not ev['last_triggered_date'] and ev.get('event_year') == now.year and
                               ev.get('event_month') == now.month and ev.get('event_day') == now.day)
            elif recurrence == 'daily':
                should_fire = ev['last_triggered_date'] != date_key
            elif recurrence == 'weekly':
                current_dow_js = (now.weekday() + 1) % 7
                should_fire = current_dow_js == ev.get('event_day') and ev['last_triggered_date'] != date_key
            elif recurrence == 'monthly':
                should_fire = now.day == ev.get('event_day') and ev['last_triggered_date'] != date_key
            if not should_fire:
                continue
            mode = ev['ranking_mode']
            rank_rows = db_query(f"""
                SELECT id FROM users
                WHERE best_scores->>'{mode}' IS NOT NULL AND best_scores->>'{mode}' != '0'
                ORDER BY (best_scores->>'{mode}')::bigint DESC LIMIT 1 OFFSET %s
            """, [ev['rank_position'] - 1])
            if rank_rows:
                target_id = rank_rows[0]['id']
                db_execute('UPDATE users SET coins = coins + %s WHERE id = %s', [ev['reward_coins'], target_id])
                print(f"🎁 イベント報酬配布: {target_id} に {ev['reward_coins']}コイン（{mode}ランキング{ev['rank_position']}位）")
            if recurrence == 'once':
                db_execute('DELETE FROM scheduled_events WHERE id = %s', [ev['id']])
            else:
                db_execute('UPDATE scheduled_events SET last_triggered_date = %s WHERE id = %s', [date_key, ev['id']])
    except Exception as err:
        print(f'イベントスケジューラーエラー: {err}')


# ===================== 🆕 週替わりチャレンジ =====================
def get_weekly_challenge_week_key(now):
    d = now.replace(hour=0, minute=0, second=0, microsecond=0)
    d -= timedelta(days=(d.weekday() + 1) % 7)
    sunday_9am = d.replace(hour=9, minute=0)
    if now < sunday_9am:
        d -= timedelta(days=7)
    return jst_date_key(d)


def run_weekly_challenge_scheduler():
    try:
        now = jst_now()
        week_key = get_weekly_challenge_week_key(now)
        if db_query('SELECT * FROM weekly_challenge WHERE week_key = %s', [week_key]):
            return
        prev = db_query('SELECT * FROM weekly_challenge ORDER BY id DESC LIMIT 1')
        if prev:
            prev_week_key = prev[0]['week_key']
            top = db_query('SELECT user_id FROM weekly_challenge_scores WHERE week_key=%s ORDER BY score DESC LIMIT 1',
                           [prev_week_key])
            if top:
                db_execute('UPDATE users SET coins = coins + %s WHERE id = %s',
                           [WEEKLY_CHALLENGE_REWARD, top[0]['user_id']])
                print(f"🎁 週替わりチャレンジ報酬: {top[0]['user_id']} に{WEEKLY_CHALLENGE_REWARD}コイン")
        modes = ['soft', 'baked', 'hard', 'extreme']
        db_execute(
            'INSERT INTO weekly_challenge (week_key, mode, size) VALUES (%s, %s, %s) ON CONFLICT (week_key) DO NOTHING',
            [week_key, random.choice(modes), random.randint(5, 18)]
        )
        print(f'🎲 新しい週替わりチャレンジを生成しました ({week_key})')
    except Exception as err:
        print(f'週替わりチャレンジスケジューラーエラー: {err}')


@app.get('/api/weekly-challenge')
def weekly_challenge_get():
    try:
        now = jst_now()
        week_key = get_weekly_challenge_week_key(now)
        challenge_rows = db_query('SELECT * FROM weekly_challenge WHERE week_key = %s', [week_key])
        if not challenge_rows:
            return jsonify({'challenge': None})
        challenge = challenge_rows[0]
        ranking_rows = db_query(
            'SELECT user_id, score FROM weekly_challenge_scores WHERE week_key=%s ORDER BY score DESC LIMIT 10',
            [week_key]
        )
        my_score = None
        token = get_token_from_request()
        if token:
            try:
                my_id = jwt.decode(token, JWT_SECRET, algorithms=['HS256'])['id']
                mine = db_query('SELECT score FROM weekly_challenge_scores WHERE week_key=%s AND user_id=%s',
                               [week_key, my_id])
                if mine:
                    my_score = mine[0]['score']
            except Exception:
                pass
        y, m, d = [int(p) for p in week_key.split('-')]
        next_reset = now.replace(year=y, month=m, day=d, hour=9, minute=0, second=0, microsecond=0) + timedelta(days=7)
        return jsonify({
            'challenge': {'weekKey': week_key, 'mode': challenge['mode'], 'size': challenge['size'],
                         'reward': WEEKLY_CHALLENGE_REWARD,
                         'secondsUntilReset': round((next_reset - now).total_seconds())},
            'ranking': [{'id': r['user_id'], 'score': r['score']} for r in ranking_rows],
            'myScore': my_score, 'hasPlayed': my_score is not None
        })
    except Exception as err:
        print(err)
        return jsonify({'error': '取得に失敗しました'}), 500


@app.post('/api/weekly-challenge/submit')
def weekly_challenge_submit():
    try:
        user_id = require_auth()
        body = request.get_json(silent=True) or {}
        score = body.get('score')
        if not isinstance(score, (int, float)) or score < 0:
            raise ApiError('正しいスコアを送信してください', 400)
        now = jst_now()
        week_key = get_weekly_challenge_week_key(now)
        if not db_query('SELECT * FROM weekly_challenge WHERE week_key = %s', [week_key]):
            raise ApiError('現在挑戦できるチャレンジがありません', 400)
        if db_query('SELECT * FROM weekly_challenge_scores WHERE week_key=%s AND user_id=%s', [week_key, user_id]):
            raise ApiError('今週はすでに挑戦済みです（1人1回まで）', 400)
        db_execute('INSERT INTO weekly_challenge_scores (week_key, user_id, score) VALUES (%s, %s, %s)',
                   [week_key, user_id, score])
        return jsonify({'ok': True})
    except ApiError as e:
        return jsonify({'error': e.message}), e.status
    except Exception as err:
        if 'unique' in str(err).lower() or 'duplicate' in str(err).lower():
            return jsonify({'error': '今週はすでに挑戦済みです（1人1回まで）'}), 400
        return jsonify({'error': '送信に失敗しました'}), 500


# ===================== お知らせ(管理者コマンド /announce の配信を表示) =====================
@app.get('/api/announcements/latest')
def announcements_latest():
    try:
        rows = db_query('SELECT id, message, created_at FROM announcements ORDER BY id DESC LIMIT 1')
        if not rows:
            return jsonify({'announcement': None})
        return jsonify({'announcement': rows[0]})
    except Exception:
        return jsonify({'announcement': None})


# ===================== 🆕 ご要望・不具合報告(Discordへ転送) =====================
@app.post('/api/feedback/request')
def feedback_request():
    body = request.get_json(silent=True) or {}
    message = (body.get('message') or '').strip()
    if not message:
        return jsonify({'error': 'メッセージを入力してください'}), 400
    user_id = get_user_id_optional()
    try:
        sent = send_discord_notification(
            DISCORD_WEBHOOK_FEATURE_REQUEST, '💡 新しいご要望', message[:3800], 0xFFD93D,
            [{'name': '送信者', 'value': user_id, 'inline': True}]
        )
        if not sent:
            return jsonify({'error': 'Discordへの送信に失敗しました。時間をおいて再度お試しください。'}), 502
        return jsonify({'ok': True})
    except Exception as err:
        print('要望送信エラー:', err)
        return jsonify({'error': '送信に失敗しました'}), 500


@app.post('/api/feedback/report')
def feedback_report():
    body = request.get_json(silent=True) or {}
    message = (body.get('message') or '').strip()
    image_base64 = body.get('imageBase64')
    if not message:
        return jsonify({'error': 'メッセージを入力してください'}), 400
    user_id = get_user_id_optional()
    try:
        image_bytes = None
        image_mime_type = 'image/png'
        image_ext = 'png'
        if image_base64:
            match = re.match(r'^data:(image/(\w+));base64,(.+)$', image_base64)
            if match:
                image_mime_type = match.group(1)
                image_ext = 'jpg' if match.group(2) == 'jpeg' else match.group(2)
                base64_data = match.group(3)
            else:
                base64_data = re.sub(r'^data:image/\w+;base64,', '', image_base64)
            image_bytes = base64.b64decode(base64_data)
            if len(image_bytes) > 8 * 1024 * 1024:
                return jsonify({'error': '画像サイズが大きすぎます（8MBまで）'}), 400
        sent = send_discord_notification(
            DISCORD_WEBHOOK_BUG_REPORT, '🐞 不具合の報告', message[:3800], 0xFF5555,
            [{'name': '報告者', 'value': user_id, 'inline': True}],
            image_bytes, f'report.{image_ext}', image_mime_type
        )
        if not sent:
            return jsonify({'error': 'Discordへの送信に失敗しました。時間をおいて再度お試しください。'}), 502
        return jsonify({'ok': True})
    except Exception as err:
        print('報告送信エラー:', err)
        return jsonify({'error': '送信に失敗しました'}), 500


# ===================== クエスト管理API =====================
@app.get('/api/quests/progress')
def quests_progress():
    try:
        user_id = require_auth()
        rows = db_query('SELECT quest_progress FROM users WHERE id = %s', [user_id])
        return jsonify({'progress': (rows[0].get('quest_progress') if rows else None) or {}})
    except ApiError as e:
        return jsonify({'error': e.message}), e.status


@app.post('/api/quests/update')
def quests_update():
    try:
        user_id = require_auth()
        body = request.get_json(silent=True) or {}
        quest_id = body.get('questId')
        rows = db_query('SELECT quest_progress FROM users WHERE id = %s', [user_id])
        quest_progress = (rows[0].get('quest_progress') if rows else None) or {}
        quest_progress[quest_id] = {'progress': body.get('progress'), 'claimed': body.get('claimed') or False}
        db_execute('UPDATE users SET quest_progress = %s WHERE id = %s', [json.dumps(quest_progress), user_id])
        return jsonify({'success': True, 'questProgress': quest_progress})
    except ApiError as e:
        return jsonify({'error': e.message}), e.status


@app.post('/api/quests/claim')
def quests_claim():
    try:
        user_id = require_auth()
        body = request.get_json(silent=True) or {}
        quest_id = body.get('questId')
        reward = body.get('reward') or 0
        rows = db_query('SELECT quest_progress, coins FROM users WHERE id = %s', [user_id])
        quest_progress = (rows[0].get('quest_progress') if rows else None) or {}
        current_coins = int((rows[0].get('coins') if rows else 0) or 0)
        if (quest_progress.get(quest_id) or {}).get('claimed'):
            return jsonify({'error': 'このクエストは既に受け取り済みです'}), 400
        new_coins = current_coins + reward
        quest_progress[quest_id] = {'progress': (quest_progress.get(quest_id) or {}).get('progress', 0), 'claimed': True}
        db_execute('UPDATE users SET quest_progress = %s, coins = %s WHERE id = %s',
                   [json.dumps(quest_progress), new_coins, user_id])
        return jsonify({'success': True, 'coins': new_coins, 'questProgress': quest_progress})
    except ApiError as e:
        return jsonify({'error': e.message}), e.status


# ===================== アカウント削除 =====================
@app.delete('/api/account/delete')
def account_delete():
    try:
        user_id = require_auth()
        db_execute('DELETE FROM users WHERE id = %s', [user_id])
        return jsonify({'success': True})
    except ApiError as e:
        return jsonify({'error': e.message}), e.status


# ===================== 🆕 フレンドAPI =====================
@app.post('/api/friends/request')
def friends_request():
    try:
        user_id = require_auth()
        body = request.get_json(silent=True) or {}
        to_id = body.get('toId')
        if not to_id or to_id == user_id:
            return jsonify({'error': '有効なユーザーIDを指定してください'}), 400
        if not db_query('SELECT id FROM users WHERE id = %s', [to_id]):
            return jsonify({'error': 'ユーザーが見つかりません'}), 404
        if are_friends(user_id, to_id):
            return jsonify({'error': '既にフレンドです'}), 400
        existing = db_query(
            'SELECT * FROM friend_requests WHERE (from_id=%s AND to_id=%s) OR (from_id=%s AND to_id=%s)',
            [user_id, to_id, to_id, user_id]
        )
        pending_opposite = next((r for r in existing if r['status'] == 'pending' and r['from_id'] == to_id and r['to_id'] == user_id), None)
        if pending_opposite:
            db_execute('DELETE FROM friend_requests WHERE id = %s', [pending_opposite['id']])
            db_execute('INSERT INTO friends (user_id, friend_id) VALUES (%s,%s),(%s,%s) ON CONFLICT DO NOTHING',
                       [user_id, to_id, to_id, user_id])
            return jsonify({'success': True, 'autoAccepted': True})
        pending_same = next((r for r in existing if r['status'] == 'pending' and r['from_id'] == user_id and r['to_id'] == to_id), None)
        if pending_same:
            return jsonify({'error': '既に申請済みです'}), 400
        db_execute("""
            INSERT INTO friend_requests (from_id, to_id, status) VALUES (%s,%s,'pending')
            ON CONFLICT (from_id, to_id) DO UPDATE SET status='pending', created_at=NOW()
        """, [user_id, to_id])
        return jsonify({'success': True})
    except ApiError as e:
        return jsonify({'error': e.message}), e.status
    except Exception as err:
        return jsonify({'error': str(err) or 'サーバーエラー'}), 500


@app.post('/api/friends/respond')
def friends_respond():
    try:
        user_id = require_auth()
        body = request.get_json(silent=True) or {}
        from_id = body.get('fromId')
        action = body.get('action')
        if not from_id or action not in ('accept', 'decline'):
            return jsonify({'error': '不正なリクエストです'}), 400
        if not db_query("SELECT * FROM friend_requests WHERE from_id=%s AND to_id=%s AND status='pending'", [from_id, user_id]):
            return jsonify({'error': '申請が見つかりません'}), 404
        db_execute('DELETE FROM friend_requests WHERE from_id=%s AND to_id=%s', [from_id, user_id])
        if action == 'accept':
            db_execute('INSERT INTO friends (user_id, friend_id) VALUES (%s,%s),(%s,%s) ON CONFLICT DO NOTHING',
                       [user_id, from_id, from_id, user_id])
        return jsonify({'success': True})
    except ApiError as e:
        return jsonify({'error': e.message}), e.status


@app.post('/api/friends/cancel')
def friends_cancel():
    try:
        user_id = require_auth()
        body = request.get_json(silent=True) or {}
        db_execute("DELETE FROM friend_requests WHERE from_id=%s AND to_id=%s AND status='pending'",
                   [user_id, body.get('toId')])
        return jsonify({'success': True})
    except ApiError as e:
        return jsonify({'error': e.message}), e.status


@app.delete('/api/friends/remove')
def friends_remove():
    try:
        user_id = require_auth()
        body = request.get_json(silent=True) or {}
        friend_id = body.get('friendId')
        db_execute('DELETE FROM friends WHERE (user_id=%s AND friend_id=%s) OR (user_id=%s AND friend_id=%s)',
                   [user_id, friend_id, friend_id, user_id])
        return jsonify({'success': True})
    except ApiError as e:
        return jsonify({'error': e.message}), e.status


@app.get('/api/friends/list')
def friends_list():
    try:
        user_id = require_auth()
        friends_rows = db_query("""
            SELECT u.id, u.best_score, u.coins,
              (u.last_active IS NOT NULL AND u.last_active > NOW() - INTERVAL '20 seconds') AS online
            FROM friends f JOIN users u ON u.id = f.friend_id WHERE f.user_id = %s ORDER BY u.id
        """, [user_id])
        incoming = db_query("SELECT from_id AS id, created_at FROM friend_requests WHERE to_id=%s AND status='pending' ORDER BY created_at DESC", [user_id])
        outgoing = db_query("SELECT to_id AS id, created_at FROM friend_requests WHERE from_id=%s AND status='pending' ORDER BY created_at DESC", [user_id])
        return jsonify({'friends': friends_rows, 'incoming': incoming, 'outgoing': outgoing})
    except ApiError as e:
        return jsonify({'error': e.message}), e.status


# ===================== 🆕 フレンド対決(デュエル) =====================
@app.post('/api/duels/challenge')
def duels_challenge():
    try:
        user_id = require_auth()
        body = request.get_json(silent=True) or {}
        opponent_id = body.get('opponentId')
        if not opponent_id:
            raise ApiError('対戦相手を指定してください', 400)
        if not are_friends(user_id, opponent_id):
            raise ApiError('フレンドのみ対決できます', 403)
        rows = db_query('INSERT INTO duels (challenger_id, opponent_id) VALUES (%s, %s) RETURNING *',
                        [user_id, opponent_id])
        return jsonify({'duel': rows[0]})
    except ApiError as e:
        return jsonify({'error': e.message}), e.status
    except Exception as err:
        return jsonify({'error': str(err) or 'サーバーエラー'}), 500


@app.post('/api/duels/<duel_id>/respond')
def duels_respond(duel_id):
    try:
        user_id = require_auth()
        body = request.get_json(silent=True) or {}
        accept = body.get('accept')
        rows = db_query('SELECT * FROM duels WHERE id=%s', [duel_id])
        if not rows:
            raise ApiError('対決が見つかりません', 404)
        if rows[0]['opponent_id'] != user_id:
            raise ApiError('権限がありません', 403)
        new_status = 'accepted' if accept else 'declined'
        db_execute('UPDATE duels SET status=%s WHERE id=%s', [new_status, duel_id])
        return jsonify({'ok': True, 'status': new_status})
    except ApiError as e:
        return jsonify({'error': e.message}), e.status


@app.get('/api/duels/list')
def duels_list():
    try:
        user_id = require_auth()
        rows = db_query('SELECT * FROM duels WHERE challenger_id=%s OR opponent_id=%s ORDER BY created_at DESC LIMIT 30',
                        [user_id, user_id])
        return jsonify({'duels': rows})
    except ApiError as e:
        return jsonify({'error': e.message}), e.status


@app.post('/api/duels/<duel_id>/submit-score')
def duels_submit_score(duel_id):
    try:
        user_id = require_auth()
        body = request.get_json(silent=True) or {}
        score = body.get('score')
        rows = db_query('SELECT * FROM duels WHERE id=%s', [duel_id])
        if not rows:
            raise ApiError('対決が見つかりません', 404)
        duel = rows[0]
        if duel['challenger_id'] != user_id and duel['opponent_id'] != user_id:
            raise ApiError('権限がありません', 403)
        if duel['status'] not in ('accepted', 'completed'):
            raise ApiError('この対決はまだ受諾されていません', 400)
        column = 'challenger_score' if duel['challenger_id'] == user_id else 'opponent_score'
        db_execute(f'UPDATE duels SET {column} = %s WHERE id = %s', [score, duel_id])
        d = db_query('SELECT * FROM duels WHERE id=%s', [duel_id])[0]
        if d['challenger_score'] is not None and d['opponent_score'] is not None and d['status'] != 'completed':
            db_execute("UPDATE duels SET status='completed' WHERE id=%s", [duel_id])
            d['status'] = 'completed'
            WIN_REWARD, DRAW_REWARD = 200, 50
            if d['challenger_score'] > d['opponent_score']:
                db_execute('UPDATE users SET coins = coins + %s WHERE id = %s', [WIN_REWARD, d['challenger_id']])
            elif d['opponent_score'] > d['challenger_score']:
                db_execute('UPDATE users SET coins = coins + %s WHERE id = %s', [WIN_REWARD, d['opponent_id']])
            else:
                db_execute('UPDATE users SET coins = coins + %s WHERE id = %s', [DRAW_REWARD, d['challenger_id']])
                db_execute('UPDATE users SET coins = coins + %s WHERE id = %s', [DRAW_REWARD, d['opponent_id']])
        return jsonify({'duel': d})
    except ApiError as e:
        return jsonify({'error': e.message}), e.status


# ===================== DM API =====================
@app.get('/api/dm/messages/<friend_id>')
def dm_messages(friend_id):
    try:
        user_id = require_auth()
        if not are_friends(user_id, friend_id):
            raise ApiError('フレンドのみDMできます', 403)
        rows = db_query("""
            SELECT id, from_id, to_id, message, timestamp FROM dm_messages
            WHERE (from_id=%s AND to_id=%s) OR (from_id=%s AND to_id=%s)
            ORDER BY timestamp DESC LIMIT 100
        """, [user_id, friend_id, friend_id, user_id])
        db_execute("UPDATE dm_messages SET is_read = TRUE WHERE from_id=%s AND to_id=%s AND is_read=FALSE",
                   [friend_id, user_id])
        return jsonify(list(reversed(rows)))
    except ApiError as e:
        return jsonify({'error': e.message}), e.status


@app.post('/api/dm/send')
def dm_send():
    try:
        user_id = require_auth()
        body = request.get_json(silent=True) or {}
        to_id = body.get('toId')
        message = body.get('message')
        if not message or not message.strip():
            raise ApiError('メッセージを入力してください', 400)
        if len(message) > 300:
            raise ApiError('メッセージは300文字以内にしてください', 400)
        if not are_friends(user_id, to_id):
            raise ApiError('フレンドのみDMできます', 403)
        rows = db_query(
            'INSERT INTO dm_messages (from_id, to_id, message) VALUES (%s,%s,%s) RETURNING id, from_id, to_id, message, timestamp',
            [user_id, to_id, message.strip()]
        )
        return jsonify(rows[0])
    except ApiError as e:
        return jsonify({'error': e.message}), e.status


@app.get('/api/dm/unread-summary')
def dm_unread_summary():
    try:
        user_id = require_auth()
        rows = db_query('SELECT from_id, message FROM dm_messages WHERE to_id=%s AND is_read=FALSE', [user_id])
        total = len(rows)
        mention_re = re.compile(r'@' + re.escape(user_id) + r'\b', re.IGNORECASE)
        mentions = sum(1 for r in rows if mention_re.search(r['message'] or ''))
        per_friend = {}
        for r in rows:
            per_friend[r['from_id']] = per_friend.get(r['from_id'], 0) + 1
        return jsonify({'total': total, 'mentions': mentions, 'perFriend': per_friend})
    except ApiError as e:
        return jsonify({'error': e.message}), e.status


# ===================== 管理者コマンド =====================
@app.post('/api/admin/command')
def admin_command():
    token = get_token_from_request()
    if not token:
        return jsonify({'error': '認証が必要です'}), 401
    try:
        user_id = jwt.decode(token, JWT_SECRET, algorithms=['HS256'])['id']
    except Exception:
        return jsonify({'error': '認証エラー'}), 401
    if user_id != 'admin':
        return jsonify({'error': '管理者権限がありません'}), 403

    body = request.get_json(silent=True) or {}
    command = body.get('command')
    if not command:
        return jsonify({'error': 'コマンドを入力してください'}), 400

    parts = command.strip().split()
    cmd = parts[0].lower()
    args = parts[1:]
    result = ''

    def to_int(s):
        try:
            return int(s)
        except (TypeError, ValueError):
            return None

    try:
        if cmd == '/setcoins':
            if len(args) < 2:
                raise ValueError('使用法: /setcoins <ユーザーID> <amount>')
            target_id = args[0]
            amount = to_int(args[1])
            if amount is None or amount < 0:
                raise ValueError('正しいコイン数を指定してください')
            if not db_query('SELECT id FROM users WHERE id = %s', [target_id]):
                raise ValueError(f'ユーザー {target_id} は見つかりません')
            db_execute('UPDATE users SET coins = %s WHERE id = %s', [amount, target_id])
            result = f'✅ {target_id} のコインを {amount} に設定しました。'

        elif cmd == '/addcoins':
            if len(args) < 2:
                raise ValueError('使用法: /addcoins <ユーザーID> <amount>')
            target_id = args[0]
            amount = to_int(args[1])
            if amount is None:
                raise ValueError('正しいコイン数を指定してください')
            rows = db_query('SELECT coins FROM users WHERE id = %s', [target_id])
            if not rows:
                raise ValueError(f'ユーザー {target_id} は見つかりません')
            new_total = max(0, int(rows[0].get('coins') or 0) + amount)
            db_execute('UPDATE users SET coins = %s WHERE id = %s', [new_total, target_id])
            result = f'✅ {target_id} のコインに {amount} を加算しました（合計: {new_total}）。'

        elif cmd == '/setscore':
            if len(args) < 3:
                raise ValueError('使用法: /setscore <ユーザーID> <mode> <score>')
            target_id, mode = args[0], args[1]
            score = to_int(args[2])
            valid_modes = ['soft', 'baked', 'hard', 'extreme', 'tetris', 'timeattack']
            if mode not in valid_modes:
                raise ValueError(f"モードは {', '.join(valid_modes)} のいずれかです")
            if score is None or score < 0:
                raise ValueError('正しいスコアを指定してください')
            rows = db_query('SELECT best_scores, admin_forced_scores FROM users WHERE id = %s', [target_id])
            if not rows:
                raise ValueError(f'ユーザー {target_id} は見つかりません')
            best_scores = rows[0].get('best_scores') or {}
            best_scores[mode] = score
            # 「管理者が入れた仮の値」に印を付ける。
            # 次にそのモードを実際にプレイしたら、この値は消えて本物の結果で上書きされる。
            forced = rows[0].get('admin_forced_scores') or {}
            forced[mode] = True
            regular_modes = ['soft', 'baked', 'hard', 'extreme']
            regular_scores = [best_scores[m] for m in regular_modes if isinstance(best_scores.get(m), (int, float))]
            max_score = max(regular_scores) if regular_scores else 0
            db_execute('UPDATE users SET best_scores = %s, best_score = %s, admin_forced_scores = %s WHERE id = %s',
                       [json.dumps(best_scores), max_score, json.dumps(forced), target_id])
            result = (f'✅ {target_id} の {mode}モードのベストスコアを {score} に設定しました。\n'
                      f'※ これは「1回だけ有効」な仮の値です。次に {mode} をプレイすると、その結果で上書きされます。')

        elif cmd == '/safety':
            if len(args) == 0:
                rows = db_query('SELECT admin_settings FROM users WHERE id = %s', [user_id])
                settings = (rows[0].get('admin_settings') if rows else None) or {'safetyMode': False}
                result = f"現在のセーフティモード: {'ON' if settings.get('safetyMode') else 'OFF'}"
            else:
                mode = args[0].lower()
                if mode not in ('on', 'off'):
                    raise ValueError('on または off を指定してください')
                safety_mode = mode == 'on'
                rows = db_query('SELECT admin_settings FROM users WHERE id = %s', [user_id])
                settings = (rows[0].get('admin_settings') if rows else None) or {'disabledBlocks': [], 'safetyMode': False}
                settings['safetyMode'] = safety_mode
                db_execute('UPDATE users SET admin_settings = %s WHERE id = %s', [json.dumps(settings), user_id])
                result = f'✅ 強制セーフティモードを {mode} に設定しました。'

        elif cmd == '/resetquests':
            db_execute('UPDATE users SET quest_progress = %s', [json.dumps({})])
            result = '✅ 全ユーザーのクエスト進捗をリセットしました。'

        elif cmd == '/setplaytime':
            time_val = to_int(args[0]) if args else None
            if time_val is None or time_val < 0:
                raise ValueError('正しいプレイ時間（秒）を指定してください')
            db_execute('UPDATE users SET play_time = %s WHERE id = %s', [time_val, user_id])
            result = f'✅ プレイ時間を {time_val}秒 に設定しました。'

        elif cmd == '/ban':
            target_id = args[0] if args else None
            if not target_id:
                raise ValueError('使用法: /ban <ユーザーID>')
            db_execute('UPDATE users SET banned = true WHERE id = %s', [target_id])
            result = f'✅ {target_id} をBANしました。'

        elif cmd == '/unban':
            target_id = args[0] if args else None
            if not target_id:
                raise ValueError('使用法: /unban <ユーザーID>')
            db_execute('UPDATE users SET banned = false WHERE id = %s', [target_id])
            result = f'✅ {target_id} のBANを解除しました。'

        elif cmd == '/resetuser':
            target_id = args[0] if args else None
            if not target_id:
                raise ValueError('使用法: /resetuser <ユーザーID>')
            db_execute("""
                UPDATE users SET best_score = 0, best_scores = '{}', coins = 0,
                    skins = '["default"]', quest_progress = '{}', play_time = 0
                WHERE id = %s
            """, [target_id])
            result = f'✅ {target_id} のデータをリセットしました。'

        elif cmd == '/listusers':
            rows = db_query('SELECT id, best_score, coins, play_time FROM users ORDER BY best_score DESC LIMIT 20')
            result = '📊 ユーザー一覧 (TOP20):\n' + '\n'.join(
                f"{u['id']}: {u['best_score']}点, {u['coins']}コイン, {u['play_time']}秒" for u in rows
            )

        elif cmd == '/search':
            target_id = args[0] if args else None
            if not target_id:
                raise ValueError('使用法: /search <ユーザーID>')
            rows = db_query('SELECT * FROM users WHERE id = %s', [target_id])
            if not rows:
                raise ValueError(f'ユーザー {target_id} は見つかりません')
            u = rows[0]
            created_str = u['created_at'].strftime('%Y/%m/%d %H:%M:%S') if u.get('created_at') else '不明'
            last_login_str = u['last_login'].strftime('%Y/%m/%d %H:%M:%S') if u.get('last_login') else 'なし'
            result = (f"🔍 ユーザー情報:\nID: {u['id']}\n🏆 ベストスコア: {u['best_score']}\n"
                     f"🪙 コイン: {u['coins']}\n⏱️ プレイ時間: {u.get('play_time') or 0}秒\n"
                     f"🚫 BAN: {'BAN中' if u.get('banned') else 'なし'}\n📅 作成日: {created_str}\n"
                     f"📅 最終ログイン: {last_login_str}")

        elif cmd == '/announce':
            message = ' '.join(args)
            if not message:
                raise ValueError('使用法: /announce <メッセージ>')
            db_execute('INSERT INTO announcements (message) VALUES (%s)', [message])
            result = f'📢 全ユーザーにお知らせを配信しました:\n「{message}」'

        elif cmd == '/stats':
            total_users = db_query('SELECT COUNT(*) AS c FROM users')[0]['c']
            total_score = db_query('SELECT SUM(best_score) AS s FROM users')[0]['s'] or 0
            total_coins = db_query('SELECT SUM(coins) AS s FROM users')[0]['s'] or 0
            total_playtime = db_query('SELECT SUM(play_time) AS s FROM users')[0]['s'] or 0
            result = (f'📊 サーバー統計:\n👤 総ユーザー数: {total_users}\n🏆 総スコア: {total_score}\n'
                     f'🪙 総コイン: {total_coins}\n⏱️ 総プレイ時間: {total_playtime}秒')

        elif cmd == '/eventadd':
            if len(args) < 9:
                raise ValueError(
                    '使用法: /eventadd <once|daily|weekly|monthly> <mode> <順位> <コイン> <年> <月> <日> <時> <分>\n'
                    '例1) 一度だけ: /eventadd once baked 1 500 2026 12 25 20 0\n'
                    '例2) 毎日: /eventadd daily baked 1 500 0 0 0 20 0\n'
                    '例3) 毎週(3=水曜): /eventadd weekly baked 1 500 0 0 3 20 0\n'
                    '例4) 毎月(15日): /eventadd monthly baked 1 500 0 0 15 20 0'
                )
            recurrence = args[0].lower()
            ev_mode = args[1]
            rank_pos = to_int(args[2])
            reward_coins = to_int(args[3])
            ev_year, ev_month, ev_day = to_int(args[4]), to_int(args[5]), to_int(args[6])
            hour_jst, minute_jst = to_int(args[7]), to_int(args[8])
            valid_modes2 = ['soft', 'baked', 'hard', 'extreme', 'tetris', 'timeattack']
            valid_recurrence = ['once', 'daily', 'weekly', 'monthly']
            if recurrence not in valid_recurrence:
                raise ValueError(f"繰り返しは {', '.join(valid_recurrence)} のいずれかです")
            if ev_mode not in valid_modes2:
                raise ValueError(f"モードは {', '.join(valid_modes2)} のいずれかです")
            if rank_pos is None or rank_pos < 1:
                raise ValueError('順位は1以上で指定してください')
            if reward_coins is None:
                raise ValueError('コイン数を指定してください')
            if hour_jst is None or hour_jst < 0 or hour_jst > 23:
                raise ValueError('時間は0〜23で指定してください（日本時間）')
            if minute_jst is None or minute_jst < 0 or minute_jst > 59:
                raise ValueError('分は0〜59で指定してください')
            if recurrence == 'once' and (ev_year is None or ev_month is None or ev_day is None):
                raise ValueError('onceの場合は年・月・日を正しく指定してください')
            if recurrence == 'weekly' and (ev_day is None or ev_day < 0 or ev_day > 6):
                raise ValueError('weeklyの場合は「日」を曜日(0=日〜6=土)で指定してください')
            if recurrence == 'monthly' and (ev_day is None or ev_day < 1 or ev_day > 31):
                raise ValueError('monthlyの場合は「日」を日付(1〜31)で指定してください')
            rows = db_query("""
                INSERT INTO scheduled_events (recurrence, ranking_mode, rank_position, reward_coins, event_year, event_month, event_day, hour_jst, minute_jst)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *
            """, [recurrence, ev_mode, rank_pos, reward_coins, ev_year or None, ev_month or None, ev_day if ev_day is not None else None, hour_jst, minute_jst])
            result = f'✅ イベントを追加しました（ID: {rows[0]["id"]}）: [{recurrence}] 「{ev_mode}」ランキング{rank_pos}位へ{reward_coins}コインを自動配布します。'

        elif cmd == '/eventlist':
            rows = db_query('SELECT * FROM scheduled_events ORDER BY id')
            if not rows:
                result = '登録されているイベントはありません。'
            else:
                lines = []
                wdays = ['日', '月', '火', '水', '木', '金', '土']
                for e in rows:
                    time_str = f"{e['hour_jst']:02d}:{(e.get('minute_jst') or 0):02d}"
                    if e['recurrence'] == 'once':
                        when_str = f"{e['event_year']}/{e['event_month']}/{e['event_day']} {time_str}に一度だけ"
                    elif e['recurrence'] == 'daily':
                        when_str = f'毎日{time_str}'
                    elif e['recurrence'] == 'weekly':
                        when_str = f"毎週{wdays[e['event_day']]}曜 {time_str}"
                    elif e['recurrence'] == 'monthly':
                        when_str = f"毎月{e['event_day']}日 {time_str}"
                    else:
                        when_str = time_str
                    lines.append(f"ID{e['id']}: {when_str}(JST) 「{e['ranking_mode']}」{e['rank_position']}位 → {e['reward_coins']}コイン")
                result = '📅 登録済みイベント一覧:\n' + '\n'.join(lines)

        elif cmd == '/eventremove':
            if not args:
                raise ValueError('使用法: /eventremove <ID>')
            rows = db_query('DELETE FROM scheduled_events WHERE id=%s RETURNING *', [args[0]])
            if not rows:
                raise ValueError(f'イベントID {args[0]} は見つかりません')
            result = f'✅ イベントID {args[0]} を削除しました。'

        else:
            result = """📋 使用可能なコマンド:
  /setcoins <ユーザーID> <amount> - 指定ユーザーのコインを設定
  /addcoins <ユーザーID> <amount> - 指定ユーザーのコインに加算（元のコイン+amount）
  /setscore <ユーザーID> <mode> <score> - 指定ユーザーのモード別スコア設定 (soft, baked, hard, extreme, tetris, timeattack)
  /safety [on|off] - 強制セーフティモード（引数なしで状態表示）
  /announce <メッセージ> - 全ユーザーにお知らせを配信
  /eventadd <once|daily|weekly|monthly> <mode> <順位> <コイン> <年> <月> <日> <時> <分> - ランキング順位者へコインを自動配布するイベントを追加(JST基準)
  /eventlist - 登録済みイベント一覧を表示
  /eventremove <ID> - イベントを削除
  /resetquests - 全ユーザーのクエスト進捗リセット
  /setplaytime <seconds> - プレイ時間を設定
  /ban <ID> - ユーザーをBAN
  /unban <ID> - BAN解除
  /resetuser <ID> - ユーザーデータリセット
  /listusers - ユーザー一覧表示
  /search <ID> - ユーザー情報検索
  /stats - サーバー統計情報
  /help - このヘルプ"""

        return jsonify({'success': True, 'result': result})
    except ValueError as ve:
        return jsonify({'error': str(ve)}), 400
    except Exception as err:
        return jsonify({'error': str(err) or 'サーバーエラー'}), 400


# ===================== 管理者API（ブロック設定用） =====================
@app.get('/api/admin/block-settings')
def admin_block_settings():
    token = get_token_from_request()
    if not token:
        return jsonify({'error': '認証が必要です'}), 401
    try:
        user_id = jwt.decode(token, JWT_SECRET, algorithms=['HS256'])['id']
        if user_id != 'admin':
            return jsonify({'error': '管理者権限がありません'}), 403
        rows = db_query('SELECT admin_settings FROM users WHERE id = %s', [user_id])
        settings = (rows[0].get('admin_settings') if rows else None) or {'disabledBlocks': [], 'safetyMode': False}
        return jsonify(settings)
    except Exception:
        return jsonify({'error': '認証エラー'}), 401


@app.post('/api/admin/block-toggle')
def admin_block_toggle():
    token = get_token_from_request()
    if not token:
        return jsonify({'error': '認証が必要です'}), 401
    try:
        user_id = jwt.decode(token, JWT_SECRET, algorithms=['HS256'])['id']
        if user_id != 'admin':
            return jsonify({'error': '管理者権限がありません'}), 403
        body = request.get_json(silent=True) or {}
        block_index = body.get('blockIndex')
        enabled = body.get('enabled')
        rows = db_query('SELECT admin_settings FROM users WHERE id = %s', [user_id])
        settings = (rows[0].get('admin_settings') if rows else None) or {'disabledBlocks': [], 'safetyMode': False}
        if enabled:
            settings['disabledBlocks'] = [i for i in settings.get('disabledBlocks', []) if i != block_index]
        else:
            if block_index not in settings.get('disabledBlocks', []):
                settings.setdefault('disabledBlocks', []).append(block_index)
        db_execute('UPDATE users SET admin_settings = %s WHERE id = %s', [json.dumps(settings), user_id])
        return jsonify({'success': True, 'settings': settings})
    except Exception:
        return jsonify({'error': '認証エラー'}), 401


# ===================== 🆕 チャットAPI =====================
@app.get('/api/chat/messages')
def chat_messages():
    try:
        rows = db_query('SELECT id, user_id, message, timestamp FROM chat_messages ORDER BY timestamp DESC LIMIT 50')
        return jsonify(list(reversed(rows)))
    except Exception as err:
        print(err)
        return jsonify({'error': 'メッセージ取得エラー'}), 500


@app.post('/api/chat/send')
def chat_send():
    token = get_token_from_request()
    if not token:
        return jsonify({'error': '認証が必要です'}), 401
    try:
        user_id = jwt.decode(token, JWT_SECRET, algorithms=['HS256'])['id']
        body = request.get_json(silent=True) or {}
        message = body.get('message')
        if not message or len(message.strip()) == 0:
            return jsonify({'error': 'メッセージを入力してください'}), 400
        if len(message) > 200:
            return jsonify({'error': 'メッセージは200文字以内にしてください'}), 400
        rows = db_query(
            'INSERT INTO chat_messages (user_id, message) VALUES (%s, %s) RETURNING id, user_id, message, timestamp',
            [user_id, message.strip()]
        )
        db_execute("""
            DELETE FROM chat_messages WHERE id NOT IN (
                SELECT id FROM chat_messages ORDER BY timestamp DESC LIMIT 50
            )
        """)
        return jsonify(rows[0])
    except Exception as err:
        print(err)
        return jsonify({'error': '認証エラー'}), 401


# ===================== 🆕 プロフィールAPI =====================
@app.get('/api/user/profile/<user_id_param>')
def user_profile(user_id_param):
    try:
        rows = db_query('SELECT id, best_score, coins, play_time, created_at FROM users WHERE id = %s', [user_id_param])
        if not rows:
            return jsonify({'error': 'ユーザーが見つかりません'}), 404
        user = rows[0]
        return jsonify({
            'userId': user['id'], 'bestScore': user['best_score'], 'coins': int(user['coins'] or 0),
            'playTime': user.get('play_time') or 0,
            'joinedAt': user['created_at'].isoformat() if user.get('created_at') else None
        })
    except Exception as err:
        print(err)
        return jsonify({'error': 'プロフィール取得エラー'}), 500


# ===================== 起動処理 =====================
def start_app():
    try:
        init_db()
        print('✅ データベース初期化完了')
    except Exception as err:
        # テーブル作成に失敗しても、原因（大抵はDATABASE_URLかSSL設定）が
        # ログに残るようにしつつ、プロセス自体は落とさない
        print(f'❌ データベース初期化エラー: {err}')

    scheduler = BackgroundScheduler(timezone='UTC')
    scheduler.add_job(run_event_scheduler, 'interval', seconds=60, id='event_scheduler')
    scheduler.add_job(run_weekly_challenge_scheduler, 'interval', seconds=60, id='weekly_challenge_scheduler')
    scheduler.start()
    # 起動直後にも一度実行しておく(未生成の週替わりチャレンジをすぐ生成するため)
    run_weekly_challenge_scheduler()


start_app()

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 3000))
    app.run(host='0.0.0.0', port=port)
