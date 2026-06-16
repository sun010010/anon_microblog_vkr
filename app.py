# Импорт необходимых библиотек
from flask import Flask, request, jsonify
import html
from flask_cors import CORS
import bcrypt
import jwt
import sqlite3
import re
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from datetime import datetime, timedelta, timezone
from dotenv import load_dotenv
import os
from functools import wraps
from db import get_db, init_db
import logging
from datetime import datetime

# Загрузка переменных окружения из .env
load_dotenv()

# Создание экземпляра приложения Flask
app = Flask(__name__)

# Настройка CORS (разрешаем кросс-доменные запросы с указанными источниками)
CORS(app, 
     supports_credentials=True,
     origins=["http://127.0.0.1:5500", "http://localhost:5500", "https://127.0.0.1:5000"])

# Создание папки для логов, если её нет
log_dir = 'logs'
if not os.path.exists(log_dir):
    os.makedirs(log_dir)

# Путь к файлу журнала безопасности
log_file = os.path.join(log_dir, 'security.log')

# Настройка логирования (уровень WARNING, формат с датой и временем)
logging.basicConfig(
    filename=log_file,
    level=logging.WARNING,
    format='[%(asctime)s] %(levelname)s - %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)

# Получение секретного ключа из переменных окружения
SECRET_KEY = os.getenv("SECRET_KEY")
if not SECRET_KEY:
    raise ValueError("SECRET_KEY не найден в .env файле")

# Функция для получения реального IP-адреса клиента (учитывая прокси)
def get_client_ip():
    if request.headers.get('X-Forwarded-For'):
        return request.headers.get('X-Forwarded-For').split(',')[0].strip()
    return request.remote_addr

# Инициализация базы данных (создание таблиц)
init_db()

# Настройка ограничения частоты запросов (rate limiting)
limiter = Limiter(
    get_remote_address,
    app=app,
    default_limits=["500 per hour"],
    storage_uri="memory://",
)

# Обработчик ошибки 429 (слишком много запросов)
@app.errorhandler(429)
def ratelimit_handler(e):
    ip = get_client_ip()
    path = request.path
    logging.warning(f"Rate limit exceeded - IP: {ip}, Path: {path}")
    
    response = jsonify({"error": "Слишком много запросов. Попробуйте позже."})
    response.status_code = 429
    response.headers.add('Access-Control-Allow-Origin', 'https://127.0.0.1:5000')
    response.headers.add('Access-Control-Allow-Credentials', 'true')
    return response

# Декоратор для проверки JWT-токена (защищённые маршруты)
def token_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        token = request.cookies.get('token')
        if not token:
            ip = get_client_ip()
            logging.warning(f"Missing token - IP: {ip}, Path: {request.path}")
            return jsonify({"error": "Токен отсутствует"}), 401
        try:
            data = jwt.decode(token, SECRET_KEY, algorithms=["HS256"])
            request.user_id = data['user_id']
            request.user_login = data['login']
        except jwt.ExpiredSignatureError:
            ip = get_client_ip()
            logging.warning(f"Expired token used - User ID: unknown, IP: {ip}, Path: {request.path}")
            return jsonify({"error": "Токен истёк"}), 401
        except:
            ip = get_client_ip()
            logging.warning(f"Invalid token used - IP: {ip}, Path: {request.path}")
            return jsonify({"error": "Неверный токен"}), 401
        return f(*args, **kwargs)
    return decorated

# Маршрут регистрации нового пользователя
@app.route("/register", methods=["POST"])
@limiter.limit("3 per minute")  # Ограничение: 3 попытки в минуту
def register():
    data = request.json
    login = data.get("login")
    password = data.get("password")

    if not login or not password:
        return jsonify({"error": "Логин и пароль обязательны"}), 400
    if not re.match(r'^[a-zA-Z0-9_]{3,20}$', login):
        return jsonify({"error": "Логин 3-20 символов, буквы/цифры/_"}), 400
    if len(password) < 6:
        return jsonify({"error": "Пароль не менее 6 символов"}), 400

    hashed = bcrypt.hashpw(password.encode(), bcrypt.gensalt())

    try:
        conn = get_db()
        conn.execute("INSERT INTO users (login, password) VALUES (?, ?)", (login, hashed))
        conn.commit()
        conn.close()
        return jsonify({"status": "ok"})
    except sqlite3.IntegrityError:
        return jsonify({"error": "Пользователь уже существует"}), 400

# Маршрут входа пользователя (выдаёт JWT в httpOnly куке)
@app.route("/login", methods=["POST"])
@limiter.limit("5 per minute")  # Ограничение: 5 попыток в минуту
def login():
    data = request.json
    login = data.get("login")
    password = data.get("password")

    conn = get_db()
    user = conn.execute("SELECT * FROM users WHERE login = ?", (login,)).fetchone()
    conn.close()

    if not user or not bcrypt.checkpw(password.encode(), user["password"]):
        ip = get_client_ip()
        logging.warning(f"Failed login - login: '{login}', IP: {ip}")
        return jsonify({"error": "Неверный логин или пароль"}), 400

    token = jwt.encode({
        "user_id": user["id"],
        "login": user["login"],
        "exp": datetime.now(timezone.utc) + timedelta(hours=24)  # срок действия 24 часа
    }, SECRET_KEY, algorithm="HS256")

    response = jsonify({"status": "ok", "login": user["login"], "user_id": user["id"]})
    ip = get_client_ip()
    logging.info(f"Successful login - User: {user['login']}, IP: {ip}")
    response.set_cookie(
        "token",
        token,
        httponly=True,   # защита от XSS
        secure=True,     # передача только по HTTPS
        samesite="Lax",  # защита от CSRF
        max_age=86400    # 24 часа в секундах
    )
    return response

# Маршрут получения ленты постов (с поиском и фильтрацией)
@app.route("/posts", methods=["GET"])
def get_posts():
    search = request.args.get('search', '').strip()
    filter_type = request.args.get('filter', 'all')

    current_user_id = None
    token = request.cookies.get('token')
    if token:
        try:
            data = jwt.decode(token, SECRET_KEY, algorithms=["HS256"])
            current_user_id = data['user_id']
        except:
            pass

    base_select = """
        SELECT posts.*, users.login as author,
        (SELECT COUNT(*) FROM likes WHERE post_id = posts.id AND value = 1) as likes,
        (SELECT COUNT(*) FROM likes WHERE post_id = posts.id AND value = -1) as dislikes,
        (SELECT COUNT(*) FROM comments WHERE post_id = posts.id) as comments_count
    """
    if current_user_id:
        base_select += """,
        (SELECT value FROM likes WHERE user_id = ? AND post_id = posts.id) as user_reaction
        """
    else:
        base_select += ", NULL as user_reaction"

    from_clause = """
        FROM posts
        JOIN users ON posts.user_id = users.id
    """

    conditions = []
    params = []

    if search:
        conditions.append("posts.content LIKE ?")
        params.append(f'%{search}%')

    if filter_type == 'my' and current_user_id:
        conditions.append("posts.user_id = ?")
        params.append(current_user_id)
    elif filter_type == 'my' and not current_user_id:
        return jsonify([])

    where_clause = ""
    if conditions:
        where_clause = "WHERE " + " AND ".join(conditions)

    order_clause = "ORDER BY posts.created_at DESC"
    query = base_select + from_clause + where_clause + order_clause

    conn = get_db()
    if current_user_id:
        all_params = [current_user_id] + params
        posts = conn.execute(query, all_params).fetchall()
    else:
        posts = conn.execute(query, params).fetchall()
    conn.close()

    return jsonify([dict(p) for p in posts])

# Маршрут создания нового поста (требуется авторизация)
@app.route("/posts", methods=["POST"])
@token_required
@limiter.limit("10 per minute")  # Ограничение: 10 постов в минуту
def add_post():
    data = request.json
    raw_content = data.get("content")
    if not raw_content or len(raw_content.strip()) == 0:
        return jsonify({"error": "Пост не может быть пустым"}), 400
    
    # Экранирование HTML для защиты от XSS
    content = html.escape(raw_content.strip())
    
    if len(content) > 500:
        return jsonify({"error": "Максимум 500 символов"}), 400

    conn = get_db()
    conn.execute("INSERT INTO posts (user_id, content) VALUES (?, ?)", (request.user_id, content))
    conn.commit()
    conn.close()
    return jsonify({"status": "ok"})

# Маршрут для установки лайка или дизлайка (или отмены оценки)
@app.route("/like/<int:post_id>", methods=["POST"])
@token_required
def like_post(post_id):
    data = request.json
    value = data.get("value")
    if value not in (1, -1, 0):
        return jsonify({"error": "Неверное значение"}), 400

    conn = get_db()
    post = conn.execute("SELECT id FROM posts WHERE id = ?", (post_id,)).fetchone()
    if not post:
        conn.close()
        return jsonify({"error": "Пост не найден"}), 404

    if value == 0:
        conn.execute("DELETE FROM likes WHERE user_id = ? AND post_id = ?", (request.user_id, post_id))
    else:
        conn.execute("""
            INSERT INTO likes (user_id, post_id, value) VALUES (?, ?, ?)
            ON CONFLICT(user_id, post_id) DO UPDATE SET value = ?
        """, (request.user_id, post_id, value, value))
    conn.commit()
    conn.close()
    return jsonify({"status": "ok"})

# Маршрут получения комментариев к посту
@app.route("/comments/<int:post_id>", methods=["GET"])
def get_comments(post_id):
    conn = get_db()
    comments = conn.execute("""
        SELECT comments.*, users.login as author
        FROM comments
        JOIN users ON comments.user_id = users.id
        WHERE comments.post_id = ?
        ORDER BY comments.created_at ASC
    """, (post_id,)).fetchall()
    conn.close()
    return jsonify([dict(c) for c in comments])

# Маршрут добавления комментария (требуется авторизация)
@app.route("/comments/<int:post_id>", methods=["POST"])
@token_required
@limiter.limit("5 per minute")  # Ограничение: 5 комментариев в минуту
def add_comment(post_id):
    data = request.json
    raw_content = data.get("content")
    if not raw_content or len(raw_content.strip()) == 0:
        return jsonify({"error": "Комментарий не может быть пустым"}), 400
    
    content = html.escape(raw_content.strip())
    
    if len(content) > 300:
        return jsonify({"error": "Максимум 300 символов"}), 400

    conn = get_db()
    post = conn.execute("SELECT id FROM posts WHERE id = ?", (post_id,)).fetchone()
    if not post:
        conn.close()
        return jsonify({"error": "Пост не найден"}), 404

    conn.execute("INSERT INTO comments (post_id, user_id, content) VALUES (?, ?, ?)",
                 (post_id, request.user_id, content))
    conn.commit()
    conn.close()
    return jsonify({"status": "ok"})

# Маршрут получения закладок текущего пользователя
@app.route("/bookmarks", methods=["GET"])
@token_required
def get_bookmarks():
    conn = get_db()
    rows = conn.execute("SELECT post_id FROM bookmarks WHERE user_id = ?", (request.user_id,)).fetchall()
    conn.close()
    return jsonify([row["post_id"] for row in rows])

# Маршрут переключения закладки (добавить/удалить)
@app.route("/bookmarks/<int:post_id>", methods=["POST"])
@token_required
def toggle_bookmark(post_id):
    conn = get_db()
    post = conn.execute("SELECT id FROM posts WHERE id = ?", (post_id,)).fetchone()
    if not post:
        conn.close()
        return jsonify({"error": "Пост не найден"}), 404

    existing = conn.execute("SELECT 1 FROM bookmarks WHERE user_id = ? AND post_id = ?",
                            (request.user_id, post_id)).fetchone()
    if existing:
        conn.execute("DELETE FROM bookmarks WHERE user_id = ? AND post_id = ?", (request.user_id, post_id))
        action = "removed"
    else:
        conn.execute("INSERT INTO bookmarks (user_id, post_id) VALUES (?, ?)", (request.user_id, post_id))
        action = "added"
    conn.commit()
    conn.close()
    return jsonify({"status": "ok", "action": action})

# Маршрут для отдачи главной HTML-страницы
@app.route('/')
def serve_index():
    index_path = os.path.join(os.path.dirname(__file__), '..', 'frontend', 'index.html')
    with open(index_path, 'r', encoding='utf-8') as f:
        return f.read()

# Маршрут для отдачи CSS-стилей
@app.route('/styles.css')
def serve_css():
    css_path = os.path.join(os.path.dirname(__file__), '..', 'frontend', 'styles.css')
    with open(css_path, 'r', encoding='utf-8') as f:
        return f.read(), 200, {'Content-Type': 'text/css'}

# Маршрут для отдачи JavaScript-файла клиента
@app.route('/app.js')
def serve_js():
    js_path = os.path.join(os.path.dirname(__file__), '..', 'frontend', 'app.js')
    with open(js_path, 'r', encoding='utf-8') as f:
        return f.read(), 200, {'Content-Type': 'application/javascript'}

# Маршрут выхода (удаление куки с токеном)
@app.route("/logout", methods=["POST"])
def logout():
    response = jsonify({"status": "ok"})
    response.set_cookie("token", "", expires=0, httponly=True)
    return response

# Маршрут редактирования поста (только для автора)
@app.route("/posts/<int:post_id>", methods=["PUT"])
@token_required
def edit_post(post_id):
    data = request.json
    new_content = data.get("content")
    
    if not new_content or len(new_content.strip()) == 0:
        return jsonify({"error": "Пост не может быть пустым"}), 400
    
    new_content = html.escape(new_content.strip())
    if len(new_content) > 500:
        return jsonify({"error": "Максимум 500 символов"}), 400
    
    conn = get_db()
    post = conn.execute("SELECT user_id FROM posts WHERE id = ?", (post_id,)).fetchone()
    if not post:
        conn.close()
        return jsonify({"error": "Пост не найден"}), 404
    
    if post["user_id"] != request.user_id:
        conn.close()
        return jsonify({"error": "Вы можете редактировать только свои посты"}), 403
    
    conn.execute("UPDATE posts SET content = ? WHERE id = ?", (new_content, post_id))
    conn.commit()
    conn.close()
    return jsonify({"status": "ok", "content": new_content})

# Запуск приложения (с самоподписанным SSL-сертификатом для HTTPS)
if __name__ == "__main__":
    app.run(debug=True, ssl_context='adhoc')
