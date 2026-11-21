
// Submission runs locally; deployed site continues to use the hosted API.
const API_BASE = ["localhost", "127.0.0.1"].includes(window.location.hostname)
    ? "https://localhost:7042/api"
    : "https://gmachmanagement-api.onrender.com/api";
const PAGE_SIZE = 6;
const normalizeCity = value => String(value ?? "").replaceAll("ירושליים","ירושלים");

const authSection = document.getElementById("authSection");
const dashboardSection = document.getElementById("dashboardSection");
const authForm = document.getElementById("authForm");
const authMessage = document.getElementById("authMessage");
const itemsMessage = document.getElementById("itemsMessage");
const borrowMessage = document.getElementById("borrowMessage");
const borrowDialog = document.getElementById("borrowDialog");

let token = sessionStorage.getItem("gmachToken");
let currentPage = 1;
let currentItems = [];
let selectedCopyId = null;
let gmachSearchSequence = 0;
let itemsRequestSequence = 0;
let authMode = "login";
let signedInName = "";
let profileNameToken = null;
async function refreshWelcomeName() {
    const activeToken = token;
    if (!activeToken || profileNameToken === activeToken) return;
    profileNameToken = activeToken;
    try {
        const profile = await apiRequest("/Auth/profiles/current");
        if (token !== activeToken) return;
        signedInName = String(profile.name || "").trim().slice(0, 60);
        renderWelcomeName();
    } catch {
        if (token === activeToken) { signedInName = ""; renderWelcomeName(); }
    }
}
function renderWelcomeName() {
    document.getElementById("welcomeText").textContent =
        token ? (signedInName ? "היי, " + signedInName + " 👋" : "היי, ברוכים הבאים 👋") : "";
}

function showMessage(element, message, type = "") {
    element.textContent = message;
    element.className = `message ${type}`;
}

function showDashboard() {
    showHome();
}

function showLogin() {
    showPage("login");
}

function logout() {
    sessionStorage.removeItem("gmachToken");
    token = null;
    signedInName = "";
    profileNameToken = null;
    currentItems = [];
    publicRequestCache.clear();
    publicPendingRequests.clear();
    document.getElementById("welcomeText").textContent = "";
    showHome();
}

// Only cache public catalog endpoints. Never cache account or owner data.
const publicRequestCache = new Map();
const publicPendingRequests = new Map();
const PUBLIC_CACHE_MS = 60000;
function publicCacheKey(path, options) {
    if (options.method && options.method.toUpperCase() !== "GET") return null;
    return /^\/(?:gmachs(?:\?|\/\d+$)|categories(?:\?|$)|items\?)/.test(path) ? path : null;
}
async function apiRequest(path, options = {}) {
    const cacheKey = publicCacheKey(path, options);
    if (!cacheKey) {
        if (options.method && options.method.toUpperCase() !== "GET") {
            publicRequestCache.clear();
            publicPendingRequests.clear();
        }
        return requestFromServer(path, options);
    }
    const cached = publicRequestCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const pending = publicPendingRequests.get(cacheKey);
    if (pending) return pending;
    const request = requestFromServer(path, options).then(result => {
        if (publicPendingRequests.get(cacheKey) === request) publicRequestCache.set(cacheKey, {value: result, expiresAt: Date.now() + PUBLIC_CACHE_MS});
        return result;
    }).finally(() => {
        if (publicPendingRequests.get(cacheKey) === request) publicPendingRequests.delete(cacheKey);
    });
    publicPendingRequests.set(cacheKey, request);
    return request;
}
async function requestFromServer(path, options = {}) {
    const headers = new Headers(options.headers || {});

    // Public directory endpoints must work without login or an expired saved token.
    const publicGmachGet = (!options.method || options.method.toUpperCase() === "GET") && /^\/gmachs(?:\?|\/\d+(?:\?|$))/.test(path);
    if (token && !publicGmachGet) {
        headers.set("Authorization", `Bearer ${token}`);
    }

    if (options.body) {
        headers.set("Content-Type", "application/json");
    }

    let response;

    try {
        response = await fetch(`${API_BASE}${path}`, {
            ...options,
            headers
        });
    } catch (error) {
        console.error("API connection failed", {
            endpoint: path,
            origin: window.location.origin,
            cause: error instanceof Error ? error.message : String(error)
        });
        throw new Error(
            "לא ניתן ליצור קשר עם שרת האתר. יש לבדוק את החיבור לאינטרנט ולנסות שוב. אם הבעיה נמשכת, יש לפתוח את כלי המפתחים (F12) ולבדוק את לשונית Network."
        );
    }

    if (response.status === 401 && token && !path.toLowerCase().includes("/auth/")) {
        logout();
        throw new Error(
            "יש להתחבר מחדש למערכת."
        );
    }

    if (!response.ok) {
        let message = `שגיאת שרת (${response.status})`;

        const text = await response.text();

        try {
            const data = JSON.parse(text);
            message = data.message || (data.errors ? Object.values(data.errors).flat().join(" ") : null) || data.title || message;
        } catch {
            if (text && text.length < 250) {
                message = text;
            }
        }

        if (response.status === 409 && (path.toLowerCase() === "/loans" || path.toLowerCase().startsWith("/borrow-requests"))) {
            throw new Error("אין עותק פנוי או שהבקשה כבר טופלה. יש לרענן את הרשימה ולנסות שוב.");
        }

        throw new Error(message);
    }

    if (response.status === 204) {
        return null;
    }

    const result = await response.json();
    return result;
}

document.getElementById("forgotPasswordBtn").addEventListener("click", async () => {
    const email = document.getElementById("email").value.trim();
    if (!email) {
        showMessage(authMessage, "יש להזין תחילה את כתובת האימייל בשדה ההתחברות.", "error");
        document.getElementById("email").focus();
        return;
    }
    const button = document.getElementById("forgotPasswordBtn");
    button.disabled = true;
    showMessage(authMessage, "שולח קישור לאיפוס סיסמה...");
    try {
        const result = await apiRequest("/Auth/password-recovery-requests", {
            method: "POST", body: JSON.stringify({ email })
        });
        showMessage(authMessage, result.message, "success");
    } catch (error) {
        showMessage(authMessage, error.message, "error");
    } finally {
        button.disabled = false;
    }
});

function showResetPasswordForm() {
    const params = new URLSearchParams(window.location.search);
    const resetEmail = params.get("resetEmail");
    const resetToken = params.get("resetToken");
    if (!resetEmail || !resetToken) return;
    showLogin();
    const section = document.getElementById("authSection");
    const form = document.createElement("form");
    form.className = "auth-form";
    const heading = document.createElement("h3");
    heading.textContent = "קביעת סיסמה חדשה";
    const label = document.createElement("label");
    label.textContent = "סיסמה חדשה (לפחות 8 תווים)";
    const password = document.createElement("input");
    password.type = "password";
    password.required = true;
    password.minLength = 8;
    password.maxLength = 128;
    password.autocomplete = "new-password";
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "primary full-width";
    submit.textContent = "שמירת סיסמה חדשה";
    const status = document.createElement("p");
    status.className = "message";
    status.setAttribute("role", "status");
    label.append(password);
    form.append(heading, label, submit, status);
    section.append(form);
    authForm.hidden = true;
    section.querySelector(".tabs").hidden = true;
    document.getElementById("forgotPasswordBtn").hidden = true;
    form.addEventListener("submit", async event => {
        event.preventDefault();
        submit.disabled = true;
        status.textContent = "מעדכן סיסמה...";
        try {
            const result = await apiRequest("/Auth/password-resets", {
                method: "POST",
                body: JSON.stringify({ email: resetEmail, token: resetToken, newPassword: password.value })
            });
            status.textContent = result.message;
            password.value = "";
            window.history.replaceState({}, "", window.location.pathname);
            submit.hidden = true;
            const back = document.createElement("button");
            back.type = "button";
            back.className = "secondary";
            back.textContent = "מעבר להתחברות";
            back.addEventListener("click", () => {
                form.remove();
                switchAuthMode("login");
            });
            form.append(back);
        } catch (error) {
            status.textContent = error.message;
            submit.disabled = false;
        }
    });
}


// התחברות
authForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    if (authMode === "register") {
        document.getElementById("requestReRegistration").hidden=true;
        const name = document.getElementById("fullName").value.trim();
        const email = document.getElementById("email").value.trim();
        const password = document.getElementById("password").value;

        if (!name) {
            showMessage(authMessage, "יש להזין שם מלא כדי להירשם.", "error");
            document.getElementById("fullName").focus();
            return;
        }

        if (password.length < 8) {
            showMessage(authMessage, "הסיסמא חייבת להכיל 8 תוים לפחות", "error");
            document.getElementById("password").focus();
            return;
        }
        showMessage(authMessage, "מבצע הרשמה...");

        try {
            const registration = await apiRequest("/Auth/accounts", {
                method: "POST",
                body: JSON.stringify({ name, email, password, isGmachOwner: document.getElementById("registerOwner").checked, gmachName: document.getElementById("gmachName").value.trim(), city: normalizeCity(document.getElementById("gmachCity").value.trim()) })
            });

            switchAuthMode("login");


            showMessage(
                authMessage,
                "ההרשמה הצליחה! כעת אפשר להתחבר.",
                "success"
            );
        } catch (error) {
            document.getElementById("requestReRegistration").hidden=!error.message.includes("הוסר בעבר");
            showMessage(authMessage, error.message, "error");
        }

        return;
    }


    const email = document.getElementById("email").value.trim();
    const password = document.getElementById("password").value;

    showMessage(authMessage, "מתחבר...");

    try {
        const result = await apiRequest("/Auth/sessions", {
            method: "POST",
            body: JSON.stringify({ email, password })
        });

        if (!result.accessToken) {
            throw new Error("השרת לא החזיר אסימון התחברות.");
        }

        token = result.accessToken;
        sessionStorage.setItem("gmachToken", token);
        signedInName = "";
        profileNameToken = null;
        showMessage(authMessage, "");
        void refreshWelcomeName();
        showDashboard();
    } catch (error) {
        showMessage(authMessage, error.message, "error");
    }
});

document.getElementById("requestReRegistration").addEventListener("click",async()=>{
    try { const email=document.getElementById("email").value.trim();if(!email)throw new Error("יש להזין כתובת אימייל.");
        const result=await apiRequest("/Auth/re-registration-requests",{method:"POST",body:JSON.stringify({email})});
        showMessage(authMessage,result.message,"success");document.getElementById("requestReRegistration").hidden=true;
    }catch(error){showMessage(authMessage,error.message,"error");}
});
function switchAuthMode(mode) {
    authMode = mode;
    authForm.hidden=false;
    document.querySelector("#authSection .tabs").hidden=false;

    document.getElementById("loginTab")
        .classList.toggle("active", mode === "login");

    document.getElementById("registerTab")
        .classList.toggle("active", mode === "register");

    document.getElementById("nameGroup").hidden =
        mode !== "register";
    document.getElementById("ownerRegistration").hidden = mode !== "register";
    // Password recovery belongs to login only, never to registration.
    document.getElementById("forgotPasswordBtn").hidden = mode !== "login";
    document.getElementById("forgotPasswordNotice").hidden = true;
    document.getElementById("password").setAttribute("autocomplete", mode === "register" ? "new-password" : "current-password");
    document.getElementById("password").minLength = 0;

    document.getElementById("authSubmit").textContent =
        mode === "login" ? "התחברות" : "הרשמה";

    showMessage(authMessage, "");
}


document.getElementById("loginTab").addEventListener(
    "click", () => switchAuthMode("login")
);

document.getElementById("registerTab").addEventListener(
    "click", () => switchAuthMode("register")
);

document.getElementById("password").addEventListener("input",()=>{if(authMode==="register"&&document.getElementById("password").value.length>=8)showMessage(authMessage,"");});

document.getElementById("logoutBtn").addEventListener(
    "click", logout
);

// טעינת פריטים מהשרת
async function loadItems() {
    const grid = document.getElementById("itemsGrid");
    const search = document.getElementById("searchInput").value.trim();
    const availableOnly =
        document.getElementById("availableOnly").checked;

    const params = new URLSearchParams({
        page: currentPage,
        pageSize: PAGE_SIZE,
        availableOnly
    });

    if (search) {
        params.set("search", search);
    }
    const category = document.getElementById("categoryFilter").value;
    if (category) params.set("categoryId", category);

    const requestSequence = ++itemsRequestSequence;
    const requestPath = `/items?${params.toString()}`;
    const cachedItems = publicRequestCache.get(requestPath);
    if (cachedItems && cachedItems.expiresAt > Date.now()) {
        renderItems(cachedItems.value);
        showMessage(itemsMessage, "");
    } else if (!currentItems.length) {
        showMessage(itemsMessage, "טוען פריטים...");
    }

    try {
        const items = await apiRequest(
            requestPath
        );
        if (requestSequence !== itemsRequestSequence) return;
        currentItems = items;
        renderItems(items);

        showMessage(
            itemsMessage,
            items.length === 0 ? "לא נמצאו פריטים." : ""
        );

        document.getElementById("pageLabel").textContent =
            `עמוד ${currentPage}`;

        document.getElementById("prevPage").disabled =
            currentPage === 1;

        document.getElementById("nextPage").disabled =
            items.length < PAGE_SIZE;

    } catch (error) {
        if (requestSequence === itemsRequestSequence) showMessage(itemsMessage, error.message, "error");
    }
}

function renderItems(items) {
    const grid = document.getElementById("itemsGrid");
    grid.replaceChildren();

    for (const item of items) {
        const available =
            item.isActive && item.availableCopies > 0;

        const card = document.createElement("article");
        card.className = "item-card";

        const title = document.createElement("h3");
        title.textContent = item.name;

        const description = document.createElement("p");
        description.className = "muted";
        description.textContent =
            item.description || "אין תיאור לפריט";

        const status = document.createElement("span");
        status.className =
            `status ${available ? "available" : "unavailable"}`;
        status.textContent = available
            ? `${item.availableCopies} עותקים זמינים`
            : "לא זמין";

        const details = document.createElement("p");
        details.className = "muted";
        details.textContent =
            `סך הכול עותקים: ${item.totalCopies}`;

        const borrowButton = document.createElement("button");
        borrowButton.className = "primary";
        borrowButton.textContent = "השאלת פריט";
        borrowButton.disabled = !available;


        borrowButton.addEventListener("click", () => {
            openBorrowDialog(item);
        });

        card.append(
            title,
            description,
            status,
            details,
            borrowButton
        );

        grid.appendChild(card);
    }
}

// חיפוש ודפדוף
document.getElementById("searchBtn").addEventListener(
    "click", () => {
        currentPage = 1;
        loadItems();
    }
);

document.getElementById("searchInput").addEventListener(
    "keydown", (event) => {
        if (event.key === "Enter") {
            currentPage = 1;
            loadItems();
        }
    }
);

document.getElementById("categoryFilter").addEventListener("change", () => { currentPage = 1; loadItems(); });
document.getElementById("availableOnly").addEventListener(
    "change", () => {
        currentPage = 1;
        loadItems();
    }
);

document.getElementById("prevPage").addEventListener(
    "click", () => {
        if (currentPage > 1) {
            currentPage--;
            loadItems();
        }
    }
);

document.getElementById("nextPage").addEventListener(
    "click", () => {
        if (currentItems.length === PAGE_SIZE) {
            currentPage++;
            loadItems();
        }
    }
);

// בחירת עותק זמין
async function openBorrowDialog(item) {
    showMessage(itemsMessage, "בודק עותקים זמינים...");

    try {
        if (!item.availableCopies) {
            showMessage(
                itemsMessage,
                "אין כרגע עותק זמין להשאלה.",
                "error"
            );
            await loadItems();
            return;
        }

        selectedCopyId = item.id;

        document.getElementById("borrowItemName").textContent =
            item.name;

        document.getElementById("borrowForm").reset();

        showMessage(borrowMessage, "");
        showMessage(itemsMessage, "");
        borrowDialog.showModal();

    } catch (error) {
        showMessage(itemsMessage, error.message, "error");
    }
}

// ביצוע השאלה
document.getElementById("borrowForm").addEventListener(
    "submit", async (event) => {
        event.preventDefault();

        if (selectedCopyId === null) {
            return;
        }

        const applicantName = document.getElementById("requestName").value.trim();
        const phone = document.getElementById("requestPhone").value.trim();
        const email = document.getElementById("requestEmail").value.trim();
        if (!phone && !email) { showMessage(borrowMessage, "יש להזין טלפון או אימייל.", "error"); return; }

        const submitButton =
            document.querySelector(
                '#borrowForm button[type="submit"]'
            );

        submitButton.disabled = true;
        showMessage(borrowMessage, "שולח בקשה...");

        try {
            await apiRequest("/borrow-requests", {
                method: "POST",
                body: JSON.stringify({
                    itemId: selectedCopyId,
                    applicantName,
                    phone: phone || null,
                    email: email || null
                })
            });

            borrowDialog.close();
            selectedCopyId = null;

            await loadItems();
            showMessage(
                itemsMessage,
                "הבקשה נשלחה בהצלחה! בעל הגמ״ח יצור איתך קשר.",
                "success"
            );

        } catch (error) {
            showMessage(borrowMessage, error.message, "error");

            if (error.message.includes("העותק נתפס") || error.message.includes("אינו זמין")) {
                await loadItems();
            }
        } finally {
            submitButton.disabled = false;
        }
    }
);

document.getElementById("cancelBorrow").addEventListener(
    "click", () => borrowDialog.close()
);

borrowDialog.addEventListener("close", () => {
    selectedCopyId = null;
});

// פתיחת המערכת
if (token) {
    showDashboard();
} else {
    showHome();
}


// Personal borrowing / lending
// Shared client-side search for item name or description in each management view.
function matchesItemSearch(query, ...fields) {
    const normalized = query.trim().toLocaleLowerCase("he");
    return !normalized || fields.some(field => String(field ?? "").toLocaleLowerCase("he").includes(normalized));
}
function filterItemCards(containerId, query) {
    const container = document.getElementById(containerId);
    for (const card of container.querySelectorAll("[data-item-search]")) {
        card.hidden = !matchesItemSearch(query, card.dataset.itemSearch);
    }
}
function applyPersonalItemSearch() {
    const query = document.getElementById("personalItemSearch").value;
    filterItemCards("openPersonalList", query);
    filterItemCards("personalList", query);
}
function applyAdminItemSearch() {
    const query = document.getElementById("adminItemSearch").value;
    filterItemCards("adminItems", query);
    filterItemCards("removedAdminItems", query);
}
document.getElementById("personalItemSearch").addEventListener("input", applyPersonalItemSearch);
document.getElementById("adminItemSearch").addEventListener("input", applyAdminItemSearch);

async function loadPersonalTransactions() {
    const historyList = document.getElementById("personalList");
    const openList = document.getElementById("openPersonalList");
    const message = document.getElementById("personalMessage");
    const openMessage = document.getElementById("openPersonalMessage");
    historyList.replaceChildren();
    openList.replaceChildren();
    try {
        const entries = await apiRequest("/personal-transactions");
        const open = entries.filter(entry => !entry.isCompleted);
        const completed = entries.filter(entry => entry.isCompleted);
        showMessage(openMessage, open.length ? "" : "אין השאלות אישיות פתוחות.");
        showMessage(message, "");
        for (const entry of entries) {
            const row = document.createElement("article");
            row.className = "item-card";
            row.dataset.itemSearch = entry.itemDescription || "";
            const title = document.createElement("h3");
            title.textContent = entry.itemDescription || "פריט";
            const details = document.createElement("p");
            details.textContent = (entry.type === 1 ? "שאלתי מ: " : "השאלתי ל: ") + entry.otherPartyName;
            const status = document.createElement("p");
            status.textContent = entry.isCompleted ? "הוחזר" : "ממתין להחזרה";
            if (entry.amount != null) details.textContent += " | סכום: " + entry.amount;
            row.append(title, details, status);
            if (!entry.isCompleted) {
                const button = document.createElement("button");
                button.className = "secondary";
                button.textContent = "סימון כהוחזר";
                button.addEventListener("click", async () => {
                    button.disabled = true;
                    try {
                        await apiRequest(`/personal-transactions/${entry.id}/completions/current`, { method: "PUT" });
                        await loadPersonalTransactions();
                    } catch (error) {
                        showMessage(openMessage, error.message, "error");
                        button.disabled = false;
                    }
                });
                row.append(button);
            }
            (entry.isCompleted ? historyList : openList).append(row);
        }
        applyPersonalItemSearch();
        if (!completed.length) {
            const empty = document.createElement("p");
            empty.textContent = "אין עדיין השאלות שהסתיימו.";
            historyList.append(empty);
        }
    } catch (error) {
        showMessage(openMessage, error.message, "error");
    }
}

document.getElementById("personalDate").value = new Date().toLocaleDateString("en-CA");
document.getElementById("personalForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const message = document.getElementById("personalMessage");
    const date = document.getElementById("personalDate").value;
    const reminder = document.getElementById("personalReminder").value;
    try {
        await apiRequest("/personal-transactions", {
            method: "POST",
            body: JSON.stringify({
                otherPartyName: document.getElementById("personalParty").value.trim(),
                itemDescription: document.getElementById("personalItem").value.trim(),
                type: Number(document.getElementById("personalType").value),
                amount: document.getElementById("personalAmount").value ? Number(document.getElementById("personalAmount").value) : null,
                transactionDate: new Date(date + "T12:00:00").toISOString(),
                reminderDate: reminder ? new Date(reminder + "T12:00:00").toISOString() : null
            })
        });
        event.target.reset();
        showMessage(message, "ההשאלה נשמרה בהצלחה.", "success");
        await loadPersonalTransactions();
    } catch (error) {
        showMessage(message, error.message, "error");
    }
});

function isAdminToken() {
    try {
        const encoded = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
        const data = JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=")));
        const role=data.role || data["http://schemas.microsoft.com/ws/2008/06/identity/claims/role"];
        return role === "GmachAdmin" || (Array.isArray(role) && role.includes("GmachAdmin"));
    } catch { return false; }
}
async function initializeAdmin() {
    const section = document.getElementById("adminSection");
    section.hidden = false;
    updateNavigation();
    if (isAdminToken()) await refreshAdmin();
}
let ownerBorrowItemId=null;
const ownerBorrowDialog=document.getElementById("ownerBorrowDialog");
function openOwnerBorrow(item){
 ownerBorrowItemId=item.id;
 document.getElementById("ownerBorrowForm").reset();
 document.getElementById("ownerBorrowItemName").textContent=item.name;
 showMessage(document.getElementById("ownerBorrowMessage"),"");
 ownerBorrowDialog.showModal();
}
document.getElementById("cancelOwnerBorrow").addEventListener("click",()=>ownerBorrowDialog.close());
document.getElementById("ownerBorrowForm").addEventListener("submit",async event=>{
 event.preventDefault();
 const borrowerName=document.getElementById("ownerBorrowName").value.trim();
 const borrowerPhone=document.getElementById("ownerBorrowPhone").value.trim();
 const borrowerEmail=document.getElementById("ownerBorrowEmail").value.trim();
 const dueDateInput=document.getElementById("ownerBorrowDueDate");
 const dueDate=dueDateInput?.value ? new Date(dueDateInput.value+"T12:00:00").toISOString() : null;
 const message=document.getElementById("ownerBorrowMessage");
 if(!borrowerName){showMessage(message,"חובה למלא שם שואל.","error");return;}
 if(!borrowerPhone&&!borrowerEmail){showMessage(message,"חובה למלא לפחות טלפון או אימייל.","error");return;}
 try{
  await apiRequest("/gmachs/mine/items/"+ownerBorrowItemId+"/loans",{method:"POST",body:JSON.stringify({borrowerName,borrowerPhone:borrowerPhone||null,borrowerEmail:borrowerEmail||null,expectedReturnDate:dueDate})});
  ownerBorrowDialog.close();await refreshAdmin();await loadItems();
 }catch(error){showMessage(message,error.message,"error");}
});
document.getElementById("managedLoansSort").addEventListener("change", () => refreshAdmin());
const selectedAdminItems = new Map();
function updateBulkToolbar() {
    const count=selectedAdminItems.size;
    document.getElementById("bulkItemActions").hidden = count===0;
    document.getElementById("selectedItemsCount").textContent = count + " פריטים נבחרו";
}
async function editAdminItem(item) {
    const name=prompt("שם הפריט",item.name);
    if(name===null||!name.trim())return;
    const description=prompt("תיאור",item.description||"");
    if(description===null)return;
    try {
        await apiRequest("/items/"+item.id,{method:"PUT",body:JSON.stringify({name:name.trim(),description})});
        await refreshAdmin();await loadItems();
    } catch(e){showMessage(document.getElementById("adminMessage"),e.message,"error");}
}
function askCopyQuantity() {
    const input=prompt("כמה עותקים להוסיף לכל פריט? (1–1000)","1");
    if(input===null)return null;
    const quantity=Number(input);
    if(!Number.isInteger(quantity)||quantity<1||quantity>1000){
        showMessage(document.getElementById("adminMessage"),"יש להזין כמות שלמה בין 1 ל־1000.","error");
        return null;
    }
    return quantity;
}
async function addAdminCopies(items) {
    const quantity=askCopyQuantity();if(quantity===null)return;
    try {
        for(const item of items) await apiRequest("/items/"+item.id+"/copy-batches?quantity="+quantity,{method:"POST"});
        await refreshAdmin();await loadItems();
        showMessage(document.getElementById("adminMessage"),"העותקים נוספו בהצלחה.","success");
    }catch(e){showMessage(document.getElementById("adminMessage"),e.message,"error");}
}
document.getElementById("bulkEditItems").addEventListener("click",async()=>{
    const items=[...selectedAdminItems.values()];
    for(const item of items)await editAdminItem(item);
});
document.getElementById("bulkAddCopies").addEventListener("click",()=>addAdminCopies([...selectedAdminItems.values()]));
document.getElementById("bulkRemoveItems").addEventListener("click",async()=>{
    const items=[...selectedAdminItems.values()];
    if(!confirm("להסיר "+items.length+" פריטים מהרשימה הפעילה? ניתן לשחזר אותם בהמשך."))return;
    try {
        for(const item of items)await apiRequest("/items/"+item.id+"/active?isActive=false",{method:"PUT"});
        await refreshAdmin();await loadItems();
    }catch(e){showMessage(document.getElementById("adminMessage"),e.message,"error");}
});
async function refreshAdmin() {
    const items = document.getElementById("adminItems");
    const loans = document.getElementById("adminLoans");
    const message = document.getElementById("adminMessage");
    items.replaceChildren();
    loans.replaceChildren();
    try {
        let gmach;
        try { gmach = await apiRequest("/gmachs/mine"); }
        catch (error) {
            document.getElementById("claimGmachForm").hidden = false;
            document.getElementById("ownerManagement").hidden = true;
            showMessage(message,"יש לשייך גמ״ח לחשבון לפני ניהול פריטים.","");
            return;
        }
        document.getElementById("claimGmachForm").hidden = true;
        document.getElementById("ownerManagement").hidden = false;
        document.getElementById("ownerGmachInfo").textContent = "הגמ״ח שלי: " + gmach.name + " — " + gmach.city;
        const pendingRequests = loadBorrowRequests();
        const catalog = gmach.items;
        const removedList = document.getElementById("removedAdminItems");
        removedList.replaceChildren();
        selectedAdminItems.clear();
        updateBulkToolbar();
        for (const item of catalog) {
            const row = document.createElement("article");
            row.className = "item-card";
            row.dataset.itemSearch = [item.name, item.description].filter(Boolean).join(" ");
            const title = document.createElement("h3");
            title.textContent = item.name;
            const details = document.createElement("p");
            details.textContent = (item.description || "") + " | עותקים: " + item.totalCopies + " | זמינים: " + item.availableCopies;
            const active = document.createElement("button");
            active.textContent = item.isActive ? "הסרת פריט" : "שחזור פריט";
            active.onclick = async () => {
                try { await apiRequest("/items/"+item.id+"/active?isActive="+(!item.isActive),{method:"PUT"}); await refreshAdmin(); await loadItems(); }
                catch(e){showMessage(message,e.message,"error");}
            };
            row.append(title,details);
            if (item.isActive) {
                const selection = document.createElement("label");
                const checkbox = document.createElement("input");
                checkbox.type = "checkbox";
                checkbox.setAttribute("aria-label", "בחירת " + item.name);
                checkbox.addEventListener("change", () => {
                    if (checkbox.checked) selectedAdminItems.set(item.id,item);
                    else selectedAdminItems.delete(item.id);
                    updateBulkToolbar();
                });
                selection.append(checkbox,document.createTextNode(" בחירה"));
                const edit = document.createElement("button");
                edit.textContent = "עריכת פריט";
                edit.onclick = () => editAdminItem(item);
                const copy = document.createElement("button");
                copy.textContent = "הוספת עותקים";
                copy.onclick = () => addAdminCopies([item]);
                const borrow = document.createElement("button");
                borrow.textContent = "סימון כהושאל";
                borrow.disabled = item.availableCopies < 1;
                borrow.onclick = () => openOwnerBorrow(item);
                row.append(selection,edit,copy,borrow,active);
                items.append(row);
            } else {
                row.append(active);
                removedList.append(row);
            }
        }
        applyAdminItemSearch();
        if (!removedList.childElementCount) {
            const empty=document.createElement("p"); empty.textContent="אין פריטים לשחזור."; removedList.append(empty);
        }
        const managedContainer=document.getElementById("managedLoans");
        managedContainer.replaceChildren();
        const [managedLoans, activeLoans] = await Promise.all([apiRequest("/gmachs/mine/managed-loans"), apiRequest("/Loans/active")]);
        const sortDirection=document.getElementById("managedLoansSort").value;
        managedLoans.sort((a,b)=>sortDirection==="oldest"
          ? new Date(a.borrowedAt)-new Date(b.borrowedAt)
          : new Date(b.borrowedAt)-new Date(a.borrowedAt));
        for(const record of managedLoans){
          const row=document.createElement("article");row.className="item-card";
          const details=document.createElement("p");
          details.textContent=(record.itemName || "פריט") + " | קוד פריט: " + (record.itemId ?? "לא ידוע") + " | " + record.borrowerName + " | " + (record.borrowerPhone||"") + " | " + (record.borrowerEmail||"");
          const borrowedDate=document.createElement("p");
          borrowedDate.textContent="הושאל בתאריך: "+new Date(record.borrowedAt).toLocaleString("he-IL",{dateStyle:"short",timeStyle:"short"});
          const returned=document.createElement("button");returned.textContent="הוחזר";
          returned.onclick=async()=>{try{await apiRequest("/gmachs/mine/managed-loans/"+record.id+"/returns/current",{method:"PUT"});await refreshAdmin();await loadItems();}catch(e){showMessage(message,e.message,"error");}};
          const dueLabel=document.createElement("label");dueLabel.textContent="מועד החזרה: ";
          const dueInput=document.createElement("input");dueInput.type="date";
          dueInput.value=record.expectedReturnDate ? record.expectedReturnDate.slice(0,10) : "";
          dueInput.onchange=async()=>{if(!dueInput.value)return;try{
            await apiRequest("/gmachs/mine/managed-loans/"+record.id+"/due-date",{method:"PUT",body:JSON.stringify({expectedReturnDate:new Date(dueInput.value+"T12:00:00").toISOString()})});
            await refreshAdmin();
          }catch(e){showMessage(message,e.message,"error");}};
          dueLabel.append(dueInput);
          row.append(details,borrowedDate,dueLabel,returned);managedContainer.append(row);
        }
        for (const loan of activeLoans) {
            const row = document.createElement("article");
            row.className = "item-card";
            const info = document.createElement("p");
            info.textContent = "השאלה "+loan.id+" | משתמש "+loan.userId+" | עותק "+loan.itemCopyId+" | עד "+new Date(loan.expectedReturnDate).toLocaleDateString("he-IL");
            const returned = document.createElement("button");
            returned.textContent = "הוחזר";
            returned.onclick = async () => {
                try {await apiRequest("/Loans/managed/"+loan.id+"/returns/current",{method:"PUT"});await refreshAdmin();await loadItems();}
                catch(e){showMessage(message,e.message,"error");}
            };
            const due = document.createElement("button");
            due.textContent = "שינוי תאריך";
            due.onclick = async () => {
                const value = prompt("תאריך חדש YYYY-MM-DD");
                if (!value) return;
                const date = new Date(value+"T12:00:00");
                if (isNaN(date.getTime())) return;
                try {await apiRequest("/Loans/"+loan.id+"/due-date",{method:"PUT",body:JSON.stringify({expectedReturnDate:date.toISOString()})});await refreshAdmin();}
                catch(e){showMessage(message,e.message,"error");}
            };
            row.append(info,returned,due);
            loans.append(row);
        }
        await pendingRequests;
    } catch(e) {showMessage(message,e.message,"error");}
}
document.getElementById("adminItemForm").addEventListener("submit",async event => {
    event.preventDefault();
    const message = document.getElementById("adminMessage");
    try {
        await apiRequest("/gmachs/mine/items",{method:"POST",body:JSON.stringify({
            name:document.getElementById("adminItemName").value.trim(),
            description:document.getElementById("adminItemDescription").value.trim()
        })});
        event.target.reset();
        await refreshAdmin(); await loadItems();
        showMessage(message,"הפריט נוסף","success");
    } catch(e){showMessage(message,e.message,"error");}
});


// Separate public catalog, login, personal account and owner management views.
function showPage(page, push = true) {
    if ((page === "account" || page === "owner" || page === "profile" || page === "siteAdmin") && !token) page = "login";
    if (page === "siteAdmin" && !isSiteAdminToken()) page = "home";
    if (page === "owner" && !isAdminToken()) page = "account";
    authSection.hidden = page !== "login";
    dashboardSection.hidden = page !== "home";
    document.getElementById("gmachPage").hidden = page !== "gmach";
    document.getElementById("accountPage").hidden = page !== "account";
    document.getElementById("profilePage").hidden = page !== "profile";
    document.getElementById("openLoansSection").hidden = page !== "account";
    document.getElementById("ownerPage").hidden = page !== "owner";
    document.getElementById("siteAdminPage").hidden = page !== "siteAdmin";
    document.getElementById("adminSection").hidden = page !== "owner";
    document.getElementById("logoutBtn").hidden = !token;
    document.getElementById("profileNav").hidden = !token;
    // Keep the current destination visible in the navigation without altering routing.
    const activeNav = {home:"homeNav",gmach:"homeNav",login:"loginNav",account:"myLoansNav",owner:"adminNav",siteAdmin:"siteAdminNav",profile:"profileNav"}[page];
    for(const id of ["homeNav","loginNav","myLoansNav","adminNav","siteAdminNav","profileNav"]){
        const button=document.getElementById(id);
        if(!button)continue;
        if(id===activeNav)button.setAttribute("aria-current","page");
        else button.removeAttribute("aria-current");
    }
    renderWelcomeName();
    if (token) void refreshWelcomeName();
    document.getElementById("loginNav").hidden = !!token;
    document.getElementById("myLoansNav").hidden = !token;
    document.getElementById("adminNav").hidden = !token || !isAdminToken();
    document.getElementById("siteAdminNav").hidden = !token || !isSiteAdminToken();
    if (push) {
        const url = new URL(location.href);
        if (page !== "gmach") url.searchParams.delete("gmach");
        if (page === "home" || page === "gmach") url.searchParams.delete("page");
        else url.searchParams.set("page", page);
        history.pushState({page}, "", url);
    }
    if (page === "home") {
        void findGmachs();
        void loadItems();
    }
    if (page === "gmach") { const id=Number(new URLSearchParams(location.search).get("gmach")); if(Number.isInteger(id)&&id>0)renderGmach(id);else showPage("home",true); }
    if (page === "account") { loadMyLoans(); loadPersonalTransactions(); }
    if (page === "owner") refreshAdmin();
    if (page === "profile") loadProfile();
    if (page === "siteAdmin") loadSiteAdmin();
    window.scrollTo({top:0,behavior:window.matchMedia("(prefers-reduced-motion: reduce)").matches?"instant":"smooth"});
}
function showHome() { showPage("home"); }

async function loadProfile(){
 const msg=document.getElementById("profileMessage");showMessage(msg,"");
 try{
  const p=await apiRequest("/Auth/profiles/current");
  document.getElementById("profileName").value=p.name||"";
  document.getElementById("profileEmail").value=p.email||"";
  document.getElementById("profileIsOwner").checked=!!p.isGmachOwner;
  document.getElementById("profileGmachName").value=p.gmachName||"";
  document.getElementById("profileGmachType").value=p.gmachType||"";
  document.getElementById("profileCity").value=normalizeCity(p.city);
  document.getElementById("profileGmachFields").hidden=!p.isGmachOwner;
  document.getElementById("profileCurrentPassword").value="";
  document.getElementById("profileNewPassword").value="";
 }catch(e){showMessage(msg,e.message,"error");}
}
document.getElementById("profileIsOwner").addEventListener("change",e=>{
 document.getElementById("profileGmachFields").hidden=!e.target.checked;
});
document.getElementById("profileShowPasswords").addEventListener("change",e=>{
 for(const id of ["profileCurrentPassword","profileNewPassword"])document.getElementById(id).type=e.target.checked?"text":"password";
});
document.getElementById("profileForm").addEventListener("submit",async e=>{
 e.preventDefault();const owner=document.getElementById("profileIsOwner").checked;
 const msg=document.getElementById("profileMessage");
 const payload={name:document.getElementById("profileName").value.trim(),email:document.getElementById("profileEmail").value.trim(),isGmachOwner:owner,
 gmachName:owner?document.getElementById("profileGmachName").value.trim():null,
 gmachType:owner?document.getElementById("profileGmachType").value.trim():null,
 city:owner?normalizeCity(document.getElementById("profileCity").value.trim()):null,
 currentPassword:document.getElementById("profileCurrentPassword").value,
 newPassword:document.getElementById("profileNewPassword").value||null};
 try{
  const result=await apiRequest("/Auth/profiles/current",{method:"PUT",body:JSON.stringify(payload)});
  if(!result.accessToken)throw new Error("נדרש להתחבר מחדש.");
  token=result.accessToken;sessionStorage.setItem("gmachToken",token);
  signedInName = String(payload.name || "").trim().slice(0, 60);
  profileNameToken = token;
  renderWelcomeName();
  updateNavigation();await loadProfile();showMessage(msg,"הפרטים עודכנו בהצלחה.","success");
 }catch(err){showMessage(msg,err.message,"error");}
});
function updateNavigation() {
    document.getElementById("loginNav").hidden = !!token;
    document.getElementById("myLoansNav").hidden = !token;
    document.getElementById("adminNav").hidden = !token || !isAdminToken();
    document.getElementById("siteAdminNav").hidden = !token || !isSiteAdminToken();
}
document.getElementById("homeNav").addEventListener("click", showHome);
document.getElementById("loginNav").addEventListener("click", showLogin);
document.getElementById("myLoansNav").addEventListener("click", () => showPage("account"));
document.getElementById("adminNav").addEventListener("click", () => showPage("owner"));
document.getElementById("siteAdminNav").addEventListener("click", () => showPage("siteAdmin"));
document.getElementById("profileNav").addEventListener("click",()=>showPage("profile"));
window.addEventListener("popstate", () => {
    const params=new URLSearchParams(location.search);
    const page=params.has("gmach")?"gmach":params.get("page")||"home";
    showPage(["login","account","owner","profile","gmach","siteAdmin"].includes(page) ? page : "home", false);
});

async function loadMyLoans() {
    if (!token) return;
    const list = document.getElementById("myLoansList");
    const message = document.getElementById("myLoansMessage");
    list.replaceChildren();
    try {
        const loans = await apiRequest("/Loans/my");
        showMessage(message, loans.length ? "" : "עדיין אין השאלות מהגמ״ח.");
        for (const loan of loans) {
            const row = document.createElement("article"); row.className = "item-card";
            const title = document.createElement("h3");
            title.textContent = loan.itemName || "פריט מספר " + loan.itemCopyId;
            const details = document.createElement("p");
            const gmachDetails = [loan.gmachName, loan.gmachCity, loan.gmachDescription].filter(Boolean).join(" | ");
            details.textContent = gmachDetails ? "פרטי הגמ״ח: " + gmachDetails : "פרטי הגמ״ח אינם זמינים";
            const due = document.createElement("p");
            due.textContent = "החזרה צפויה: " + new Date(loan.expectedReturnDate).toLocaleDateString("he-IL");
            row.append(title,details,due); list.append(row);
        }
    } catch (error) { showMessage(message,error.message,"error"); }
}

async function loadCategories() {
    const select = document.getElementById("categoryFilter");
    try {
        const categories = await apiRequest("/categories");
        for (const category of categories) {
            const option = document.createElement("option");
            option.value = category.id;
            option.textContent = category.name;
            select.appendChild(option);
        }
    } catch (error) { showMessage(itemsMessage, error.message, "error"); }
}
loadCategories();

// Gmach directory and owner onboarding
const ownerCheckbox=document.getElementById("registerOwner");
ownerCheckbox.addEventListener("change",()=>{document.getElementById("ownerFields").hidden=!ownerCheckbox.checked;});
async function findGmachs(){
 const sequence=++gmachSearchSequence;
 const list=document.getElementById("gmachList");
 const query=new URLSearchParams({city:normalizeCity(document.getElementById("citySearch").value.trim()),search:document.getElementById("gmachSearch").value.trim()});
 const itemTerm=document.getElementById("homeItemSearch").value.trim();
 if(itemTerm) query.set("itemSearch",itemTerm);
 const cacheKey="/gmachs?"+query;
 if (!publicRequestCache.has(cacheKey) && !list.children.length) {const loading=document.createElement("p");loading.textContent="טוען גמ״חים...";list.append(loading);}
 try {
  const groups=await apiRequest("/gmachs?"+query);
  if(sequence!==gmachSearchSequence)return;
  list.replaceChildren();
  for(const group of groups){
   const card=document.createElement("article");card.className="item-card";
   const heading=document.createElement("h3");heading.textContent=group.name;
   const city=document.createElement("p");city.textContent=normalizeCity(group.city);
   const button=document.createElement("button");button.className="primary";button.textContent="דף הגמ״ח";button.addEventListener("click",()=>showGmach(group.id));
   card.append(heading,city,button);list.append(card);
  }
  if(!groups.length){const empty=document.createElement("p");empty.textContent="לא נמצאו גמ״חים.";list.append(empty);}
 }catch(e){if(sequence===gmachSearchSequence){list.replaceChildren();const error=document.createElement("p");error.className="message error";error.setAttribute("role","alert");error.textContent="טעינת רשימת הגמ״חים נכשלה: "+e.message;list.append(error);}}
}
function showGmach(id){
 const url=new URL(location.href);url.searchParams.delete("page");url.searchParams.set("gmach",id);history.pushState({page:"gmach"},"",url);
 showPage("gmach",false);
}
async function renderGmach(id){
 const container=document.getElementById("gmachDetails");container.replaceChildren();
 try {const g=await apiRequest("/gmachs/"+id);const section=document.createElement("section");section.className="gmach-content";
 const grid=document.createElement("div");grid.className="gmach-items-grid";
 const title=document.createElement("h2");title.textContent=g.name+" — "+normalizeCity(g.city);section.append(title);
 const desc=document.createElement("p");desc.textContent=g.description||"";section.append(desc);
 for(const item of g.items.filter(item=>item.isActive&&item.availableCopies>0&&item.name.toLocaleLowerCase("he").includes(document.getElementById("homeItemSearch").value.trim().toLocaleLowerCase("he")))){const card=document.createElement("article");card.className="item-card";
 const name=document.createElement("h3");name.textContent=item.name;
 const info=document.createElement("p");info.textContent=(item.description||"")+" | עותקים זמינים: "+item.availableCopies;
 const button=document.createElement("button");button.textContent="השאלה";button.disabled=!item.isActive||item.availableCopies<1;
 button.addEventListener("click",()=>openBorrowDialog(item));
 card.append(name,info,button);grid.append(card);}
 section.append(grid);
 container.append(section);
 }catch(e){const message=document.createElement("p");message.className="message error";message.textContent=e.message;container.append(message);}
}
document.getElementById("backToGmachs").addEventListener("click",showHome);
document.getElementById("findGmachs").addEventListener("click",findGmachs);
for(const id of ["citySearch","gmachSearch","homeItemSearch"])document.getElementById(id).addEventListener("keydown",event=>{if(event.key==="Enter"){event.preventDefault();findGmachs();}});
const startupParams=new URLSearchParams(location.search);
const initialPage=startupParams.has("gmach")?"gmach":startupParams.get("page");
showPage(["login","account","owner","profile","gmach"].includes(initialPage)?initialPage:"home",false);
document.getElementById("excelImportForm").addEventListener("submit",async event=>{
 event.preventDefault();const file=document.getElementById("excelFile").files[0];if(!file)return;
 const form=new FormData();form.append("file",file);
 try{const response=await fetch(API_BASE+"/gmachs/mine/imports",{method:"POST",headers:{Authorization:"Bearer "+token},body:form});
 const result=await response.json();if(!response.ok)throw new Error(result.message||"ייבוא נכשל");
 showMessage(document.getElementById("adminMessage"),"יובאו "+result.imported+" פריטים בהצלחה","success");await refreshAdmin();await loadItems();await findGmachs();
 }catch(e){showMessage(document.getElementById("adminMessage"),e.message,"error");}
});

document.getElementById("claimGmachForm").addEventListener("submit",async event=>{
 event.preventDefault();
 try {
  await apiRequest("/gmachs/mine",{method:"POST",body:JSON.stringify({name:document.getElementById("claimGmachName").value.trim(),city:normalizeCity(document.getElementById("claimGmachCity").value.trim())})});
  await refreshAdmin();await findGmachs();
  showMessage(document.getElementById("adminMessage"),"הגמ״ח שויך לחשבון בהצלחה.","success");
 }catch(error){showMessage(document.getElementById("adminMessage"),error.message,"error");}
});

// Password visibility is local to each password field.
for (const [checkboxId, inputId] of [["showPassword","password"],["showNewPassword","newPassword"]]) {
    const checkbox = document.getElementById(checkboxId);
    const input = document.getElementById(inputId);
    if (checkbox && input) checkbox.addEventListener("change", event => {
        input.type = event.target.checked ? "text" : "password";
    });
}

async function loadBorrowRequests() {
 const list=document.getElementById("borrowRequestsList");
 const message=document.getElementById("borrowRequestsMessage");
 list.replaceChildren();
 try {
  const requests=await apiRequest("/borrow-requests/mine");
  showMessage(message,requests.length?"":"אין בקשות ממתינות.");
  for(const request of requests){
   const card=document.createElement("article");card.className="item-card";
   const heading=document.createElement("h3");heading.textContent=request.itemName;
   const contact=document.createElement("p");contact.textContent=[request.applicantName,request.phone,request.email].filter(Boolean).join(" | ");
   const button=document.createElement("button");button.className="primary";button.textContent="סימון כהושאל";
   button.addEventListener("click",async()=>{
    button.disabled=true;
    try{await apiRequest("/borrow-requests/mine/"+request.id+"/approvals/current",{method:"PUT"});await refreshAdmin();}
    catch(e){showMessage(message,e.message,"error");button.disabled=false;}
   });
   card.append(heading,contact,button);list.append(card);
  }
 }catch(e){showMessage(message,e.message,"error");}
}

function isSiteAdminToken() {
    if (!token) return false;
    try {
        const encoded=token.split(".")[1].replace(/-/g,"+").replace(/_/g,"/");
        const data=JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length/4)*4,"=")));
        const role=data.role||data["http://schemas.microsoft.com/ws/2008/06/identity/claims/role"];
        return role==="SiteAdmin" || (Array.isArray(role) && role.includes("SiteAdmin"));
    } catch { return false; }
}
const siteAdminMessage=document.getElementById("siteAdminMessage");
function adminActionButton(label, handler, destructive=false) {
    const button=document.createElement("button");
    button.type="button";button.textContent=label;
    button.className=destructive?"secondary":"primary";
    button.addEventListener("click",handler);
    return button;
}
async function adminPerform(path,options,success) {
    try {
        await apiRequest(path,options);
        showMessage(siteAdminMessage,success,"success");
        await loadSiteAdmin(true);
    } catch(error) { showMessage(siteAdminMessage,error.message,"error"); }
}
async function loadSiteAdmin(keepMessage=false) {
    if(!isSiteAdminToken())return;
    if(!keepMessage)showMessage(siteAdminMessage,"טוען נתוני ניהול...");
    try {
        const [users,gmachs,items,requests]=await Promise.all([
            apiRequest("/site-admin/users"),
            apiRequest("/site-admin/gmachs"),
            apiRequest("/site-admin/items"),
            apiRequest("/site-admin/re-registration-requests")
        ]);
        const usersList=document.getElementById("siteAdminUsers");
        const gmachsList=document.getElementById("siteAdminGmachs");
        const itemsList=document.getElementById("siteAdminItems");
        usersList.replaceChildren();gmachsList.replaceChildren();itemsList.replaceChildren();
        const requestsList=document.getElementById("siteAdminReRegistrations");requestsList.replaceChildren();
        for(const req of requests){const card=document.createElement("article");card.className="item-card";
            const email=document.createElement("strong");email.textContent=req.email;card.append(email);
            card.append(adminActionButton("אישור הרשמה מחדש",async()=>{
                if(confirm("לאשר הרשמה מחדש לכתובת "+req.email+"?"))await adminPerform("/site-admin/re-registration-requests/approvals",{method:"POST",body:JSON.stringify({email:req.email})},"הבקשה אושרה. המשתמש יכול להירשם מחדש.");
            }));requestsList.append(card);
        }
        for(const u of users) {
            const card=document.createElement("details");card.className="site-admin-user-row";
            card.dataset.search=(u.name+" "+u.email+" "+u.role).toLocaleLowerCase();
            const selection=document.createElement("label");selection.className="site-admin-select-label";
            const check=document.createElement("input");check.type="checkbox";check.className="site-admin-user-check";check.value=String(u.id);check.disabled=!!u.isPrimary;
            check.setAttribute("aria-label","בחירת "+u.name);
            check.addEventListener("change",updateAdminBulkSelection);
            selection.append(check,document.createTextNode(" בחירה"));card.append(selection);
            const heading=document.createElement("summary");
            const label=document.createElement("span");label.textContent=u.name;
            const meta=document.createElement("span");meta.className="site-admin-user-meta";meta.textContent=u.email+" | "+(u.role==="SiteAdmin"?"מנהל אתר":u.role==="GmachAdmin"?"בעל גמ״ח":"משתמש");
            heading.append(label,meta);card.append(heading);
            const actions=document.createElement("div");actions.className="site-admin-user-actions";
            // All management actions appear only when the user row is expanded.
            actions.append(adminActionButton("עריכת שם",async()=>{
                const name=prompt("שם חדש",u.name);
                if(name===null)return;
                if(!name.trim()){showMessage(siteAdminMessage,"יש להזין שם.","error");return;}
                await adminPerform("/site-admin/users/"+u.id,{method:"PUT",body:JSON.stringify({name:name.trim()})},"שם המשתמש עודכן.");
            }));
            if(!u.isPrimary) {
                actions.append(adminActionButton("עריכת אימייל",async()=>{
                    const next=prompt("כתובת אימייל חדשה",u.email);
                    if(next===null)return;
                    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next.trim())){showMessage(siteAdminMessage,"יש להזין כתובת אימייל תקינה.","error");return;}
                    await adminPerform("/site-admin/users/"+u.id+"/email",{method:"PUT",body:JSON.stringify({email:next.trim()})},"כתובת האימייל עודכנה. המשתמש יצטרך להתחבר מחדש.");
                }));
                if(u.role==="SiteAdmin")actions.append(adminActionButton("הסרת הרשאת מנהל",async()=>{
                    if(confirm("להסיר את הרשאת ניהול האתר מהחשבון "+u.email+"?"))
                        await adminPerform("/site-admin/administrators",{method:"POST",body:JSON.stringify({email:u.email,enabled:false})},"הרשאת המנהל הוסרה.");
                },true));
                else actions.append(adminActionButton("הפיכה למנהל אתר",async()=>{
                    if(confirm("לתת הרשאת ניהול מלאה לחשבון "+u.email+"?"))
                        await adminPerform("/site-admin/administrators",{method:"POST",body:JSON.stringify({email:u.email,enabled:true})},"הרשאת מנהל נוספה.");
                }));
                actions.append(adminActionButton("מחיקת משתמש",async()=>{
                    if(confirm("למחוק לצמיתות את החשבון "+u.email+"?"))
                        await adminPerform("/site-admin/users/"+u.id,{method:"DELETE"},"המשתמש נמחק.");
                },true));
            }
            card.append(actions);
            usersList.append(card);
        }
        for(const g of gmachs) {
            const card=document.createElement("article");card.className="item-card";
            const title=document.createElement("h3");title.textContent=g.name;
            const details=document.createElement("p");details.textContent=g.city+" | בעלים מספר "+g.ownerId;
            card.append(title,details);
            card.append(adminActionButton("עריכת פרטי גמ״ח",async()=>{
                const name=prompt("שם הגמ״ח",g.name);if(name===null)return;
                const city=prompt("עיר",g.city);if(city===null)return;
                const description=prompt("תיאור",g.description||"");if(description===null)return;
                if(!name.trim()||!city.trim()){showMessage(siteAdminMessage,"שם ועיר הם שדות חובה.","error");return;}
                await adminPerform("/site-admin/gmachs/"+g.id,{method:"PUT",body:JSON.stringify({name:name.trim(),city:city.trim(),description})},"הגמ״ח עודכן.");
            }));
            card.append(adminActionButton("מחיקת גמ״ח",async()=>{
                if(confirm("למחוק את הגמ״ח "+g.name+"? הפעולה בלתי הפיכה."))
                    await adminPerform("/site-admin/gmachs/"+g.id,{method:"DELETE"},"הגמ״ח נמחק.");
            },true));
            gmachsList.append(card);
        }
        for(const item of items) {
            const card=document.createElement("article");card.className="item-card";
            const title=document.createElement("h3");title.textContent=item.name;
            const details=document.createElement("p");details.textContent="גמ״ח מספר "+(item.gmachId||"ללא שיוך");
            card.append(title,details);
            card.append(adminActionButton("עריכת פריט",async()=>{
                const name=prompt("שם הפריט",item.name);if(name===null)return;
                const description=prompt("תיאור",item.description||"");if(description===null)return;
                if(!name.trim()){showMessage(siteAdminMessage,"יש להזין שם פריט.","error");return;}
                await adminPerform("/site-admin/items/"+item.id,{method:"PUT",body:JSON.stringify({name:name.trim(),description})},"הפריט עודכן.");
            }));
            card.append(adminActionButton("מחיקת פריט",async()=>{
                if(confirm("למחוק את הפריט "+item.name+"? הפעולה בלתי הפיכה."))
                    await adminPerform("/site-admin/items/"+item.id,{method:"DELETE"},"הפריט נמחק.");
            },true));
            itemsList.append(card);
        }
        filterSiteAdminUsers();
        updateAdminBulkSelection();
        if(!keepMessage)showMessage(siteAdminMessage,"");
    }catch(error){showMessage(siteAdminMessage,error.message,"error");}
}
document.getElementById("siteAdminGrantForm").addEventListener("submit",async event=>{
    event.preventDefault();
    const email=document.getElementById("siteAdminEmail").value.trim();
    if(!confirm("להעניק הרשאת ניהול מלאה לכתובת "+email+"?"))return;
    await adminPerform("/site-admin/administrators",{method:"POST",body:JSON.stringify({email,enabled:true})},"המנהל נוסף בהצלחה. עליו להתחבר מחדש.");
    document.getElementById("siteAdminEmail").value="";
});

function filterSiteAdminUsers(){
    const query=document.getElementById("siteAdminUserSearch").value.trim().toLocaleLowerCase();
    const rows=document.querySelectorAll("#siteAdminUsers .site-admin-user-row");
    let visible=0;
    rows.forEach(row=>{const match=row.dataset.search.includes(query);row.hidden=!match;if(match)visible++;});
    document.getElementById("siteAdminUserCount").textContent="מוצגים "+visible+" מתוך "+rows.length+" משתמשים";
    updateAdminBulkSelection();
}
document.getElementById("siteAdminUserSearch").addEventListener("input",filterSiteAdminUsers);

function updateAdminBulkSelection(){
    const boxes=[...document.querySelectorAll("#siteAdminUsers .site-admin-user-check:not(:disabled)")];
    const selected=boxes.filter(x=>x.checked);
    const visible=boxes.filter(x=>!x.closest(".site-admin-user-row").hidden);
    document.getElementById("siteAdminSelectedCount").textContent=selected.length+" משתמשים נבחרו";
    document.getElementById("siteAdminBulkDelete").disabled=selected.length===0;
    const all=document.getElementById("siteAdminSelectAll");
    all.checked=visible.length>0&&visible.every(x=>x.checked);
    all.indeterminate=visible.some(x=>x.checked)&&!all.checked;
}
document.getElementById("siteAdminSelectAll").addEventListener("change",event=>{
    document.querySelectorAll("#siteAdminUsers .site-admin-user-row:not([hidden]) .site-admin-user-check:not(:disabled)").forEach(x=>x.checked=event.target.checked);
    updateAdminBulkSelection();
});
document.getElementById("siteAdminBulkDelete").addEventListener("click",async()=>{
    const selected=[...document.querySelectorAll("#siteAdminUsers .site-admin-user-check:checked")].map(x=>Number(x.value));
    if(!selected.length)return;
    if(!confirm("למחוק לצמיתות "+selected.length+" משתמשים? הפעולה אינה ניתנת לביטול."))return;
    const button=document.getElementById("siteAdminBulkDelete");
    button.disabled=true;
    let deleted=0;const failures=[];
    for(const id of selected){
        try{await apiRequest("/site-admin/users/"+id,{method:"DELETE"});deleted++;}
        catch(error){failures.push("משתמש "+id+": "+error.message);}
    }
    await loadSiteAdmin(true);
    showMessage(siteAdminMessage,"נמחקו "+deleted+" משתמשים."+(failures.length?" לא נמחקו: "+failures.join("; "):""),failures.length?"error":"success");
});

showResetPasswordForm();
