// Глобальные переменные состояния приложения

let currentUser = null;          // логин текущего пользователя
let currentUserId = null;        // ID текущего пользователя
let bookmarks = new Set();       // множество ID постов в закладках

// Состояние фильтрации и поиска

let currentFilter = 'all';       // текущий фильтр: 'all' или 'my'
let currentSearch = '';          // строка поискового запроса

// Всплывающие уведомления (тосты)
function showToast(type, message) {
    // создаёт и показывает уведомление с автоматическим исчезновением через 3 секунды
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerText = message;
    container.appendChild(toast);
    setTimeout(() => {
        toast.classList.add('fade-out');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// Счётчик символов для поля ввода поста
function initPostCharCounter() {
    // обновляет счётчик "0/500" при вводе текста, меняет цвет при приближении к лимиту
    const textarea = document.getElementById('message');
    const counterDiv = document.querySelector('.char-counter');
    if (!textarea || !counterDiv) return;
    const updateCounter = () => {
        const len = textarea.value.length;
        counterDiv.innerText = `${len}/500`;
        if (len > 500) counterDiv.classList.add('danger');
        else if (len > 450) { counterDiv.classList.add('warning'); counterDiv.classList.remove('danger'); }
        else { counterDiv.classList.remove('warning', 'danger'); }
    };
    textarea.addEventListener('input', updateCounter);
    updateCounter();
}

// Форматирование времени из UTC в локальное
function formatLocalTime(utcString) {
    // преобразует строку даты от сервера (UTC) в локальный формат
    if (!utcString) return '';
    let [datePart, timePart] = utcString.split(' ');
    if (!datePart || !timePart) return utcString;
    let [year, month, day] = datePart.split('-');
    let [hour, minute, second] = timePart.split(':');
    let utcDate = new Date(Date.UTC(+year, +month - 1, +day, +hour, +minute, +second));
    return utcDate.toLocaleString();
}

// Построение URL для запроса постов с параметрами
function buildPostsUrl() {
    // собирает URL с текущими параметрами поиска и фильтрации
    let url = "https://127.0.0.1:5000/posts?";
    const params = new URLSearchParams();
    if (currentSearch) params.append('search', currentSearch);
    if (currentFilter) params.append('filter', currentFilter);
    return url + params.toString();
}

// Загрузка и отображение ленты постов
async function loadPosts() {
    // получает посты с сервера и рендерит их в контейнер
    const url = buildPostsUrl();
    try {
        const res = await fetch(url, { credentials: "include" });
        if (res.status === 401) { logout(); return; }
        if (!res.ok) throw new Error('Ошибка загрузки постов');
        const posts = await res.json();
        const container = document.getElementById("posts");
        container.innerHTML = "";
        for (let p of posts) {
            container.appendChild(renderPost(p));
        }
        updateBookmarksPanel();
        handleHashOnLoad();
    } catch (err) {
        showToast("error", "Не удалось загрузить посты");
    }
}

function reloadPosts() {
    // перезагружает ленту, если основное окно активно
    if (document.getElementById("main").style.display === "block") {
        loadPosts();
    }
}

// Плавный скролл к посту по его ID
function scrollToPost(postId) {
    // прокручивает страницу к посту и подсвечивает его на 1.5 сек
    const element = document.getElementById(`post-${postId}`);
    if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        element.style.transition = 'background 0.3s';
        element.style.backgroundColor = '#f9f2c0';
        setTimeout(() => {
            element.style.backgroundColor = '';
        }, 1500);
    }
}

// Регистрация нового пользователя
async function register() {
    // валидирует логин/пароль и отправляет POST-запрос на /register
    const login = document.getElementById("login").value.trim();
    const password = document.getElementById("password").value;
    if (!login || !password) return showToast("error", "Заполните поля");
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(login)) return showToast("error", "Логин 3-20 символов, буквы/цифры/_");
    if (password.length < 6) return showToast("error", "Пароль минимум 6 символов");

    const res = await fetch("https://127.0.0.1:5000/register", {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({login, password})
    });
    const data = await res.json();
    if (data.status === "ok") showToast("success", "Регистрация успешна");
    else showToast("error", data.error || "Ошибка");
}

// Вход пользователя (аутентификация)
async function loginUser() {
    // отправляет логин/пароль, получает JWT в куке, переключает интерфейс
    const login = document.getElementById("login").value.trim();
    const password = document.getElementById("password").value;
    try {
        const res = await fetch("https://127.0.0.1:5000/login", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            credentials: "include",
            body: JSON.stringify({login, password})
        });
        const data = await res.json();
        if (data.status === "ok") {
            currentUser = data.login;
            currentUserId = data.user_id;
            localStorage.setItem("user", currentUser);
            localStorage.setItem("userId", currentUserId);
            // переключаем видимость блоков
            document.getElementById("auth").style.display = "none";
            document.getElementById("main").style.display = "block";
            document.getElementById("bookmarks-panel").style.display = "block";
            // сбрасываем фильтры и поиск
            currentFilter = 'all';
            currentSearch = '';
            const searchInput = document.getElementById('search-input');
            if (searchInput) searchInput.value = '';
            document.getElementById('filter-all').classList.add('active');
            document.getElementById('filter-my').classList.remove('active');
            // загружаем закладки и ленту
            await loadBookmarks();
            await loadPosts();
            handleHashOnLoad();
        } else {
            showToast("error", data.error || "Ошибка входа");
        }
    } catch (err) {
        showToast("error", "Ошибка соединения с сервером");
    }
}

// Отправка нового поста (с индикатором загрузки)
async function sendMessage() {
    // проверяет текст, отправляет POST на /posts, блокирует кнопку на время отправки
    const text = document.getElementById("message").value.trim();
    if (!text) return showToast("error", "Пост не может быть пустым");
    if (text.length > 500) return showToast("error", "Максимум 500 символов");
    
    const sendBtn = document.querySelector('.post-editor button');
    const originalText = sendBtn.textContent;
    sendBtn.disabled = true;
    sendBtn.textContent = '⏳ Отправка...';
    
    try {
        const res = await fetch("https://127.0.0.1:5000/posts", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            credentials: "include",
            body: JSON.stringify({content: text})
        });
        if (res.ok) {
            document.getElementById("message").value = "";
            document.getElementById("message").dispatchEvent(new Event('input'));
            await reloadPosts();
        } else {
            const err = await res.json();
            showToast("error", err.error || "Ошибка");
        }
    } finally {
        sendBtn.disabled = false;
        sendBtn.textContent = originalText;
    }
}

// Управление лайками и дизлайками
async function setLike(postId, newValue, likeBtn, dislikeBtn) {
    // определяет текущую оценку, вычисляет новое значение и отправляет на сервер
    let currentValue = 0;
    if (likeBtn.classList.contains('active')) currentValue = 1;
    if (dislikeBtn.classList.contains('active')) currentValue = -1;
    let sendValue = (currentValue === newValue) ? 0 : newValue;

    const response = await fetch(`https://127.0.0.1:5000/like/${postId}`, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        credentials: "include",
        body: JSON.stringify({ value: sendValue })
    });
    if (!response.ok) return;
    await reloadPosts();
}

// Закладки: загрузка, переключение, обновление панели
async function loadBookmarks() {
    // получает список ID закладок с сервера и обновляет состояние
    try {
        const res = await fetch("https://127.0.0.1:5000/bookmarks", { credentials: "include" });
        if (res.ok) {
            const data = await res.json();
            bookmarks.clear();
            data.forEach(id => bookmarks.add(id));
            updateBookmarksPanel();
            // обновляем активные кнопки закладок в уже отрисованных постах
            document.querySelectorAll('.post').forEach(postDiv => {
                const postId = parseInt(postDiv.id.split('-')[1]);
                const btn = postDiv.querySelector('.bookmark-btn');
                if (btn) {
                    if (bookmarks.has(postId)) btn.classList.add('active');
                    else btn.classList.remove('active');
                }
            });
        }
    } catch (err) { /* игнорируем ошибки */ }
}

async function toggleBookmark(postId, btnElement) {
    // добавляет или удаляет закладку по клику на кнопку
    const res = await fetch(`https://127.0.0.1:5000/bookmarks/${postId}`, {
        method: "POST",
        credentials: "include"
    });
    if (res.ok) {
        const data = await res.json();
        if (data.action === "added") {
            bookmarks.add(postId);
            btnElement.classList.add('active');
        } else {
            bookmarks.delete(postId);
            btnElement.classList.remove('active');
        }
        updateBookmarksPanel();
    }
}

function updateBookmarksPanel() {
    // обновляет боковую панель со списком закладок
    const list = document.getElementById('bookmarks-list');
    if (!list) return;
    if (bookmarks.size === 0) {
        list.innerHTML = '<li>Нет закладок</li>';
        return;
    }
    fetchBookmarkedPosts();
}

async function fetchBookmarkedPosts() {
    // загружает полные данные по закладкам и отображает их в панели
    if (bookmarks.size === 0) {
        document.getElementById('bookmarks-list').innerHTML = '<li>Нет закладок</li>';
        return;
    }
    const res = await fetch("https://127.0.0.1:5000/posts");
    const allPosts = await res.json();
    const bookmarkedPosts = allPosts.filter(p => bookmarks.has(p.id));
    const list = document.getElementById('bookmarks-list');
    list.innerHTML = '';
    for (let post of bookmarkedPosts) {
        const li = document.createElement('li');
        li.textContent = `${post.author}: ${post.content.substring(0, 40)}...`;
        li.dataset.postid = post.id;
        li.addEventListener('click', () => scrollToPost(post.id));
        list.appendChild(li);
    }
}

// Модальное окно подтверждения выхода
function openLogoutModal() { document.getElementById('logoutModal').style.display = 'flex'; }
function closeLogoutModal() { document.getElementById('logoutModal').style.display = 'none'; }

function performLogout() {
    // отправляет запрос на /logout, очищает состояние и возвращает к форме входа
    fetch("https://127.0.0.1:5000/logout", { method: "POST", credentials: "include" });
    currentUser = null;
    currentUserId = null;
    localStorage.removeItem("user");
    localStorage.removeItem("userId");
    bookmarks.clear();
    document.getElementById("auth").style.display = "block";
    document.getElementById("main").style.display = "none";
    document.getElementById("bookmarks-panel").style.display = "none";
    document.getElementById("login").value = "";
    document.getElementById("password").value = "";
    closeLogoutModal();
    showToast("info", "Вы вышли из системы");
}

function logout() { openLogoutModal(); } // вызывается по кнопке "Выйти"

function initLogoutModal() {
    // навешивает обработчики на кнопки модального окна выхода
    document.getElementById('confirmLogoutBtn')?.addEventListener('click', performLogout);
    document.getElementById('cancelLogoutBtn')?.addEventListener('click', closeLogoutModal);
    document.getElementById('logoutModal')?.addEventListener('click', (e) => {
        if (e.target === e.currentTarget) closeLogoutModal();
    });
}

// Редактирование постов (только своих)
let currentEditingPostId = null;

function openEditModal(postId, currentContent) {
    // открывает модалку с текущим текстом поста и счётчиком символов
    currentEditingPostId = postId;
    const textarea = document.getElementById('editPostContent');
    const counter = document.getElementById('editCharCounter');
    textarea.value = currentContent;
    counter.innerText = `${currentContent.length}/500`;
    document.getElementById('editModal').style.display = 'flex';
    textarea.oninput = () => {
        const len = textarea.value.length;
        counter.innerText = `${len}/500`;
        if (len > 500) counter.style.color = '#e74c3c';
        else if (len > 450) counter.style.color = '#e67e22';
        else counter.style.color = '';
    };
}

async function saveEditedPost() {
    // отправляет PUT-запрос на обновление поста
    const newContent = document.getElementById('editPostContent').value.trim();
    if (!newContent) return showToast("error", "Пост не может быть пустым");
    if (newContent.length > 500) return showToast("error", "Максимум 500 символов");
    const res = await fetch(`https://127.0.0.1:5000/posts/${currentEditingPostId}`, {
        method: "PUT",
        headers: {"Content-Type": "application/json"},
        credentials: "include",
        body: JSON.stringify({content: newContent})
    });
    if (res.ok) {
        closeEditModal();
        await reloadPosts();
        showToast("success", "Пост обновлён");
    } else {
        const err = await res.json();
        showToast("error", err.error || "Ошибка редактирования");
    }
}

function closeEditModal() {
    document.getElementById('editModal').style.display = 'none';
    currentEditingPostId = null;
}

function initEditModal() {
    // навешивает обработчики на кнопки модалки редактирования
    document.getElementById('saveEditBtn')?.addEventListener('click', saveEditedPost);
    document.getElementById('cancelEditBtn')?.addEventListener('click', closeEditModal);
    document.getElementById('editModal')?.addEventListener('click', (e) => {
        if (e.target === e.currentTarget) closeEditModal();
    });
}

// Копирование ссылки на пост в буфер обмена
function copyPostLink(postId) {
    const url = `${window.location.origin}${window.location.pathname}#post-${postId}`;
    navigator.clipboard.writeText(url).then(() => {
        showToast("success", "Ссылка скопирована!");
    });
}

// Обработка хеша в URL (прокрутка к посту)
function handleHashOnLoad() {
    // при загрузке страницы проверяет хеш #post-<id> и прокручивает к посту
    const hash = window.location.hash;
    if (hash && hash.startsWith('#post-')) {
        const postId = parseInt(hash.split('-')[1]);
        const checkExist = setInterval(() => {
            const postElement = document.getElementById(`post-${postId}`);
            if (postElement) {
                clearInterval(checkExist);
                scrollToPost(postId);
            }
        }, 200);
    }
}

// Комментарии: ленивая загрузка, добавление, счётчик
async function loadComments(postId, containerId) {
    // загружает комментарии при первом клике, потом только скрывает/показывает
    const container = document.getElementById(containerId);
    if (container.dataset.loaded === "true") {
        container.style.display = container.style.display === "none" ? "block" : "none";
        return;
    }
    const res = await fetch(`https://127.0.0.1:5000/comments/${postId}`);
    const comments = await res.json();
    container.innerHTML = "";
    for (let c of comments) {
        const div = document.createElement("div");
        div.className = "comment";
        div.innerHTML = `<span class="comment-author">${escapeHtml(c.author)}</span> <span class="comment-text">${escapeHtml(c.content)}</span>`;
        container.appendChild(div);
    }
    // форма добавления комментария
    const formDiv = document.createElement("div");
    formDiv.className = "comment-form";
    formDiv.innerHTML = `
        <input type="text" class="comment-input" id="comment-input-${postId}" placeholder="Ваш комментарий..." maxlength="300">
        <div class="comment-char-counter" id="comment-counter-${postId}">0/300</div>
        <button onclick="addComment(${postId})">Отправить</button>
    `;
    container.appendChild(formDiv);

    const commentInput = document.getElementById(`comment-input-${postId}`);
    const counterSpan = document.getElementById(`comment-counter-${postId}`);
    if (commentInput && counterSpan) {
        const updateCommentCounter = () => {
            const len = commentInput.value.length;
            counterSpan.innerText = `${len}/300`;
            if (len > 300) counterSpan.style.color = '#e74c3c';
            else if (len > 250) counterSpan.style.color = '#e67e22';
            else counterSpan.style.color = '';
        };
        commentInput.addEventListener('input', updateCommentCounter);
        updateCommentCounter();
    }

    container.dataset.loaded = "true";
    container.style.display = "block";
}

async function addComment(postId) {
    // отправляет новый комментарий на сервер и перезагружает список
    const input = document.getElementById(`comment-input-${postId}`);
    const text = input.value.trim();
    if (!text) return;
    if (text.length > 300) return showToast("error", "Максимум 300 символов");
    await fetch(`https://127.0.0.1:5000/comments/${postId}`, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        credentials: "include",
        body: JSON.stringify({content: text})
    });
    input.value = "";
    if (input) input.dispatchEvent(new Event('input'));
    const container = document.getElementById(`comments-${postId}`);
    container.dataset.loaded = "false";
    container.style.display = "none";
    await loadComments(postId, `comments-${postId}`);
}

// Отрисовка одного поста (карточка с кнопками)
function renderPost(post) {
    // создаёт DOM-элемент поста с учётом лайков, закладок и прав редактирования
    const div = document.createElement("div");
    div.className = "post";
    div.id = `post-${post.id}`;

    const userReaction = post.user_reaction || 0;
    const likeActive = (userReaction === 1) ? 'active' : '';
    const dislikeActive = (userReaction === -1) ? 'active' : '';
    const isBookmarked = bookmarks.has(post.id);
    const bookmarkActive = isBookmarked ? 'active' : '';
    
    let editButtonHtml = '';
    if (currentUserId === post.user_id) {
        editButtonHtml = `<button class="edit-btn" data-postid="${post.id}">✏️</button>`;
    }

    div.innerHTML = `
        <div><strong>${escapeHtml(post.author)}</strong> <small>${formatLocalTime(post.created_at)}</small></div>
        <div style="margin: 10px 0;">${escapeHtml(post.content)}</div>
        <div class="post-footer">
            <button data-postid="${post.id}" data-value="1" class="like-btn ${likeActive}">👍 <span class="likes-count">${post.likes || 0}</span></button>
            <button data-postid="${post.id}" data-value="-1" class="dislike-btn ${dislikeActive}">👎 <span class="dislikes-count">${post.dislikes || 0}</span></button>
            <button class="comments-toggle" data-postid="${post.id}">💬 Комментарии (${post.comments_count || 0})</button>
            <button class="bookmark-btn ${bookmarkActive}" data-postid="${post.id}">🔖</button>
            <button class="link-btn" data-postid="${post.id}">🔗</button>
            ${editButtonHtml}
        </div>
        <div id="comments-${post.id}" class="comments-section" style="display: none;"></div>
    `;

    // навешиваем обработчики на кнопки поста
    const likeBtn = div.querySelector(`.like-btn`);
    const dislikeBtn = div.querySelector(`.dislike-btn`);
    const commentsBtn = div.querySelector(`.comments-toggle`);
    const bookmarkBtn = div.querySelector(`.bookmark-btn`);
    const linkBtn = div.querySelector(`.link-btn`);
    const editBtn = div.querySelector(`.edit-btn`);

    likeBtn.addEventListener('click', () => setLike(post.id, 1, likeBtn, dislikeBtn));
    dislikeBtn.addEventListener('click', () => setLike(post.id, -1, likeBtn, dislikeBtn));
    commentsBtn.addEventListener('click', () => loadComments(post.id, `comments-${post.id}`));
    bookmarkBtn.addEventListener('click', () => toggleBookmark(post.id, bookmarkBtn));
    linkBtn.addEventListener('click', () => copyPostLink(post.id));
    if (editBtn) editBtn.addEventListener('click', () => openEditModal(post.id, post.content));

    return div;
}

// Защита от XSS: экранирование спецсимволов
function escapeHtml(str) {
    // заменяет <, >, & на HTML-сущности для предотвращения XSS
    if (!str) return "";
    return str.replace(/[&<>]/g, function(m) {
        if (m === '&') return '&amp;';
        if (m === '<') return '&lt;';
        if (m === '>') return '&gt;';
        return m;
    });
}

// Тёмная тема (переключение и сохранение выбора)
function initTheme() {
    // определяет тему из localStorage или системных настроек
    const saved = localStorage.getItem("theme");
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const theme = saved || (prefersDark ? "dark" : "light");
    applyTheme(theme);
}

function applyTheme(theme) {
    // устанавливает атрибут data-theme на корневой элемент и меняет иконку кнопки
    const root = document.documentElement;
    if (theme === "dark") {
        root.setAttribute("data-theme", "dark");
        document.getElementById("theme-toggle").textContent = "☀️";
    } else {
        root.setAttribute("data-theme", "light");
        document.getElementById("theme-toggle").textContent = "🌙";
    }
    localStorage.setItem("theme", theme);
}

function toggleTheme() {
    // переключает тему
    const current = document.documentElement.getAttribute("data-theme");
    applyTheme(current === "dark" ? "light" : "dark");
}

// Инициализация приложения при загрузке страницы
window.onload = () => {
    initPostCharCounter();

    // восстановление сессии (если пользователь уже был авторизован)
    const savedUser = localStorage.getItem("user");
    const savedUserId = localStorage.getItem("userId");
    if (savedUser && savedUserId) {
        currentUser = savedUser;
        currentUserId = parseInt(savedUserId);
        loadBookmarks().then(() => {
            loadPosts().then(() => {
                document.getElementById("auth").style.display = "none";
                document.getElementById("main").style.display = "block";
                document.getElementById("bookmarks-panel").style.display = "block";
                currentFilter = 'all';
                currentSearch = '';
                const searchInput = document.getElementById('search-input');
                if (searchInput) searchInput.value = '';
                handleHashOnLoad();
            }).catch(() => logout());
        }).catch(() => {
            localStorage.removeItem("user");
            localStorage.removeItem("userId");
        });
    }

    initTheme();
    initLogoutModal();
    initEditModal();
    document.getElementById("theme-toggle")?.addEventListener("click", toggleTheme);
    document.getElementById("logout-btn")?.addEventListener("click", logout);

    // кнопка "Наверх"
    const scrollBtn = document.getElementById('scroll-top-btn');
    if (scrollBtn) {
        window.addEventListener('scroll', () => {
            if (window.scrollY > 300) scrollBtn.style.display = 'flex';
            else scrollBtn.style.display = 'none';
        });
        scrollBtn.addEventListener('click', () => {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });
    }

    // поиск с debounce (задержка 500 мс)
    const searchInput = document.getElementById('search-input');
    const searchBtn = document.getElementById('search-btn');
    if (searchBtn) {
        let debounceTimeout;
        const performSearch = () => {
            currentSearch = searchInput.value.trim();
            reloadPosts();
        };
        searchBtn.addEventListener('click', performSearch);
        if (searchInput) {
            searchInput.addEventListener('input', () => {
                clearTimeout(debounceTimeout);
                debounceTimeout = setTimeout(performSearch, 500);
            });
            searchInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    clearTimeout(debounceTimeout);
                    performSearch();
                }
            });
        }
    }

    // фильтры "Все посты" / "Мои посты"
    const filterAllBtn = document.getElementById('filter-all');
    const filterMyBtn = document.getElementById('filter-my');
    if (filterAllBtn && filterMyBtn) {
        const setActiveFilter = (active) => {
            if (active === 'all') {
                filterAllBtn.classList.add('active');
                filterMyBtn.classList.remove('active');
                currentFilter = 'all';
            } else {
                filterAllBtn.classList.remove('active');
                filterMyBtn.classList.add('active');
                currentFilter = 'my';
            }
            reloadPosts();
        };
        filterAllBtn.addEventListener('click', () => setActiveFilter('all'));
        filterMyBtn.addEventListener('click', () => setActiveFilter('my'));
    }
};
