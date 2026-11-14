
const $ = id => document.getElementById(id);

// ======================================
// DATA STORAGE
// ======================================

function readStorage(key, fallback) {
    try {
        const value = localStorage.getItem(key);
        return value ? JSON.parse(value) : fallback;
    } catch (error) {
        console.error("Storage read error:", error);
        return fallback;
    }
}

let tasks = readStorage("taskoraTasks", []);
let history = readStorage("taskoraHistory", []);

let visibleMonth = new Date();
let selectedDate = new Date();

let autoSaveFileHandle = null;
let autoSaveTimer = null;
let autoSaveWriteQueue = Promise.resolve();

const priorityOrder = { High: 3, Medium: 2, Low: 1 };

tasks = tasks.map(task => ({
    ...task,
    priority: task.priority || "Medium",
    category: task.category || "Personal",
    dueDate: task.dueDate || "",
    description: task.description || "",
    completed: Boolean(task.completed),
    completedAt: task.completedAt || null
}));

function saveTasks() {
    localStorage.setItem("taskoraTasks", JSON.stringify(tasks));
    scheduleAutoFileSave();
}

function saveHistory() {
    localStorage.setItem("taskoraHistory", JSON.stringify(history));
    scheduleAutoFileSave();
}

// ======================================
// DATE HELPERS
// ======================================

function dateKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");

    return `${year}-${month}-${day}`;
}

function formatDate(value) {
    if (!value) return "No due date";

    return new Date(value + "T00:00:00").toLocaleDateString("en-IN", {
        day: "numeric",
        month: "short",
        year: "numeric"
    });
}

function formatCompletionDate(value) {
    if (!value) return "Date not recorded";

    return new Date(value).toLocaleString("en-IN", {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit"
    });
}

function isOverdue(task) {
    return !task.completed &&
        task.dueDate &&
        task.dueDate < dateKey(new Date());
}

// ======================================
// AUTOMATIC FILE SYNC
// ======================================

function openTaskoraDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open("TaskoraDatabase", 1);

        request.onupgradeneeded = () => {
            const db = request.result;

            if (!db.objectStoreNames.contains("settings")) {
                db.createObjectStore("settings");
            }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function storeFileHandle(handle) {
    const db = await openTaskoraDatabase();

    return new Promise((resolve, reject) => {
        const transaction = db.transaction("settings", "readwrite");

        transaction.objectStore("settings").put(
            handle,
            "autoSaveFileHandle"
        );

        transaction.oncomplete = () => {
            db.close();
            resolve();
        };

        transaction.onerror = () => {
            db.close();
            reject(transaction.error);
        };
    });
}

async function loadFileHandle() {
    const db = await openTaskoraDatabase();

    return new Promise((resolve, reject) => {
        const transaction = db.transaction("settings", "readonly");

        const request = transaction.objectStore("settings").get(
            "autoSaveFileHandle"
        );

        request.onsuccess = () => {
            const result = request.result || null;
            db.close();
            resolve(result);
        };

        request.onerror = () => {
            db.close();
            reject(request.error);
        };
    });
}

async function clearSavedFileHandle() {
    const db = await openTaskoraDatabase();

    return new Promise((resolve, reject) => {
        const transaction = db.transaction("settings", "readwrite");

        transaction.objectStore("settings").delete(
            "autoSaveFileHandle"
        );

        transaction.oncomplete = () => {
            db.close();
            resolve();
        };

        transaction.onerror = () => {
            db.close();
            reject(transaction.error);
        };
    });
}

function updateAutoSaveStatus(message) {
    const status = $("autoSaveStatus");

    if (status) {
        status.textContent = message;
    }
}

function createBackupData() {
    return {
        app: "Taskora",
        version: 4,
        exportedAt: new Date().toISOString(),
        tasks,
        history,
        theme: localStorage.getItem("taskoraTheme") || "dark"
    };
}

async function writeAutoSaveFile() {
    if (!autoSaveFileHandle) return;

    const handle = autoSaveFileHandle;

    const operation = async () => {
        if (autoSaveFileHandle !== handle) return;

        const permission = await handle.queryPermission({
            mode: "readwrite"
        });

        if (permission !== "granted") {
            updateAutoSaveStatus(
                "Permission needed. Reconnect your file."
            );
            return;
        }

        const writable = await handle.createWritable();

        try {
            await writable.write(
                JSON.stringify(createBackupData(), null, 2)
            );

            await writable.close();

        } catch (error) {
            try {
                await writable.abort();
            } catch (abortError) {
                console.warn(abortError);
            }

            throw error;
        }

        if (autoSaveFileHandle === handle) {
            updateAutoSaveStatus(
                "Auto-Save Connected ✓ Last saved " +
                new Date().toLocaleTimeString()
            );
        }
    };

    autoSaveWriteQueue = autoSaveWriteQueue
        .catch(() => {})
        .then(operation);

    try {
        await autoSaveWriteQueue;
    } catch (error) {
        console.error("Auto-save error:", error);

        if (error.name === "InvalidStateError") {
            autoSaveFileHandle = null;

            try {
                await clearSavedFileHandle();
            } catch (dbError) {
                console.error(dbError);
            }
        }

        updateAutoSaveStatus(
            "Auto-Save failed. Please reconnect your file."
        );
    }
}

function scheduleAutoFileSave() {
    if (!autoSaveFileHandle) return;

    clearTimeout(autoSaveTimer);

    autoSaveTimer = setTimeout(() => {
        writeAutoSaveFile();
    }, 700);
}

async function connectAutoSaveFile() {
    try {
        if (!("showSaveFilePicker" in window)) {
            alert("Please use Google Chrome or Microsoft Edge for Auto-Save.");
            return;
        }

        const handle = await window.showSaveFilePicker({
            suggestedName: "taskora-data.json",
            types: [{
                description: "Taskora JSON Backup",
                accept: {
                    "application/json": [".json"]
                }
            }]
        });

        const permission = await handle.requestPermission({
            mode: "readwrite"
        });

        if (permission !== "granted") {
            updateAutoSaveStatus("File permission not granted.");
            return;
        }

        autoSaveFileHandle = handle;

        await storeFileHandle(handle);

        updateAutoSaveStatus("Connected! Saving data...");

        await writeAutoSaveFile();

    } catch (error) {
        if (error.name === "AbortError") return;

        console.error(error);
        updateAutoSaveStatus("Could not connect file.");
        alert("Could not connect the file. Please try again.");
    }
}

async function restoreAutoSaveConnection() {
    try {
        autoSaveFileHandle = await loadFileHandle();

        if (!autoSaveFileHandle) {
            updateAutoSaveStatus("Auto-Save File: Not connected");
            return;
        }

        const permission = await autoSaveFileHandle.queryPermission({
            mode: "readwrite"
        });

        updateAutoSaveStatus(
            permission === "granted"
                ? "Auto-Save File: Connected ✓"
                : "Click Connect Auto-Save File to reconnect."
        );

    } catch (error) {
        console.error(error);

        autoSaveFileHandle = null;

        try {
            await clearSavedFileHandle();
        } catch (dbError) {
            console.error(dbError);
        }

        updateAutoSaveStatus("Auto-Save File: Not connected");
    }
}

$("autoSaveConnect").addEventListener("click", connectAutoSaveFile);

// ======================================
// NAVIGATION
// ======================================

function showPage(pageName) {
    const targetPage = $(pageName);

    if (!targetPage || !targetPage.classList.contains("page")) {
        console.error("Page not found:", pageName);
        return;
    }

    document.querySelectorAll(".page").forEach(page => {
        page.classList.remove("active");
    });

    document.querySelectorAll(".nav-link[data-page]").forEach(button => {
        button.classList.remove("active");
    });

    targetPage.classList.add("active");

    const navButton = document.querySelector(
        `.nav-link[data-page="${pageName}"]`
    );

    if (navButton) {
        navButton.classList.add("active");
    }

    const headings = {
        dashboard: "Dashboard",
        tasks: "My Tasks",
        calendar: "Calendar",
        analytics: "Analytics",
        history: "Task History",
        backup: "Backup & Restore"
    };

    $("pageHeading").textContent = headings[pageName] || "Taskora";
}

document.querySelectorAll(".nav-link[data-page]").forEach(button => {
    button.addEventListener("click", event => {
        event.preventDefault();
        showPage(button.dataset.page);
    });
});

document.querySelectorAll("[data-goto]").forEach(button => {
    button.addEventListener("click", event => {
        event.preventDefault();
        showPage(button.dataset.goto);
    });
});

// ======================================
// ADD TASK
// ======================================

$("taskForm").addEventListener("submit", event => {
    event.preventDefault();

    const name = $("taskName").value.trim();
    const dueDate = $("taskDate").value;
    const description = $("taskDescription").value.trim();

    if (!name || !dueDate) {
        alert("Please enter a task name and due date.");
        return;
    }

    tasks.unshift({
        id: Date.now(),
        name,
        dueDate,
        description,
        priority: $("taskPriority").value,
        category: $("taskCategory").value,
        completed: false,
        completedAt: null
    });

    saveTasks();

    $("taskForm").reset();

    $("taskPriority").value = "Medium";
    $("taskCategory").value = "Study";
    $("taskDate").value = dateKey(new Date());

    displayAll();
});

// ======================================
// COMPLETE / UNDO TASK
// ======================================

function completeTask(id) {
    const task = tasks.find(item => item.id === id);

    if (!task) return;

    task.completed = !task.completed;

    if (task.completed) {
        task.completedAt = new Date().toISOString();

        const record = {
            taskId: task.id,
            name: task.name,
            category: task.category,
            priority: task.priority,
            dueDate: task.dueDate,
            description: task.description,
            completedAt: task.completedAt
        };

        const existing = history.find(item => item.taskId === id);

        if (existing) {
            Object.assign(existing, record);
        } else {
            history.unshift(record);
        }

    } else {
        task.completedAt = null;
        history = history.filter(item => item.taskId !== id);
    }

    saveTasks();
    saveHistory();
    displayAll();
}

// ======================================
// EDIT TASK
// ======================================

function editTask(id) {
    const task = tasks.find(item => item.id === id);

    if (!task) return;

    const name = prompt("Edit task name:", task.name);

    if (name === null) return;

    if (!name.trim()) {
        alert("Task name cannot be empty.");
        return;
    }

    const description = prompt(
        "Edit task description:",
        task.description || ""
    );

    if (description === null) return;

    task.name = name.trim();
    task.description = description.trim();

    const record = history.find(item => item.taskId === id);

    if (record) {
        record.name = task.name;
        record.description = task.description;
    }

    saveTasks();
    saveHistory();
    displayAll();
}

// ======================================
// DELETE TASK
// ======================================

function deleteTask(id) {
    if (!confirm("Are you sure you want to delete this task?")) {
        return;
    }

    tasks = tasks.filter(item => item.id !== id);

    // History record is deliberately preserved.
    saveTasks();
    displayAll();
}

// ======================================
// TASK RENDERING
// ======================================

function renderTasks(containerId, taskArray, showHistory = false) {
    const container = $(containerId);

    container.innerHTML = "";

    if (!taskArray.length) {
        container.innerHTML = `
            <div class="empty-state">
                ${showHistory
                    ? "No completed task history yet."
                    : "No tasks found. Add your first task!"}
            </div>
        `;
        return;
    }

    taskArray.forEach(task => {
        const item = document.createElement("div");
        item.className = "task-item";

        if (task.completed || showHistory) {
            item.classList.add("is-completed");
        }

        if (!showHistory && isOverdue(task)) {
            item.classList.add("overdue");
        }

        const main = document.createElement("div");
        main.className = "task-main";

        const info = document.createElement("div");
        info.className = "task-info";

        const title = document.createElement("h4");
        title.textContent = task.name;

        const details = document.createElement("p");

        const priority = document.createElement("span");
        priority.className = `priority ${task.priority}`;
        priority.textContent = task.priority;

        const category = document.createElement("span");
        category.className = "category-tag";
        category.textContent = task.category;

        const due = document.createElement("span");
        due.textContent = `Due: ${formatDate(task.dueDate)}`;

        details.append(priority, category, due);

        if (!showHistory && isOverdue(task)) {
            const overdue = document.createElement("span");
            overdue.className = "status-tag overdue-tag";
            overdue.textContent = "OVERDUE";
            details.append(overdue);
        }

        if (task.completed || showHistory) {
            const completed = document.createElement("span");
            completed.className = "status-tag done-tag";
            completed.textContent = "COMPLETED";
            details.append(completed);
        }

        info.append(title, details);

        if (task.description) {
            const description = document.createElement("div");
            description.className = "task-description";
            description.textContent = task.description;
            info.append(description);
        }

        main.append(info);
        item.append(main);

        if (showHistory) {
            const date = document.createElement("p");
            date.className = "muted-text";
            date.textContent =
                "Completed: " + formatCompletionDate(task.completedAt);

            item.append(date);

        } else {
            const actions = document.createElement("div");
            actions.className = "task-actions";

            const done = document.createElement("button");
            done.type = "button";
            done.className = "action-button";
            done.textContent = task.completed ? "Undo" : "✓ Done";
            done.addEventListener("click", () => completeTask(task.id));

            const edit = document.createElement("button");
            edit.type = "button";
            edit.className = "action-button";
            edit.textContent = "Edit";
            edit.addEventListener("click", () => editTask(task.id));

            const remove = document.createElement("button");
            remove.type = "button";
            remove.className = "action-button delete-button";
            remove.textContent = "Delete";
            remove.addEventListener("click", () => deleteTask(task.id));

            actions.append(done, edit, remove);
            item.append(actions);
        }

        container.append(item);
    });
}

// ======================================
// SEARCH AND FILTERS
// ======================================

function getFilteredTasks() {
    const search = $("searchInput").value.toLowerCase().trim();
    const category = $("categoryFilter").value;
    const priority = $("priorityFilter").value;
    const status = $("statusFilter").value;

    return tasks.filter(task => {
        const matchesSearch =
            task.name.toLowerCase().includes(search) ||
            (task.description || "").toLowerCase().includes(search);

        const matchesCategory =
            category === "All" || task.category === category;

        const matchesPriority =
            priority === "All" || task.priority === priority;

        let matchesStatus = true;

        if (status === "Pending") matchesStatus = !task.completed;
        if (status === "Completed") matchesStatus = task.completed;
        if (status === "Overdue") matchesStatus = isOverdue(task);

        return matchesSearch &&
            matchesCategory &&
            matchesPriority &&
            matchesStatus;
    }).sort((a, b) => b.id - a.id);
}

["searchInput", "categoryFilter", "priorityFilter", "statusFilter"]
    .forEach(id => {
        $(id).addEventListener("input", () => {
            renderTasks("taskList", getFilteredTasks());
        });

        $(id).addEventListener("change", () => {
            renderTasks("taskList", getFilteredTasks());
        });
    });

// ======================================
// DASHBOARD
// ======================================

function displayDashboard() {
    const total = tasks.length;
    const completed = tasks.filter(task => task.completed).length;
    const pending = total - completed;

    const rate = total
        ? Math.round(completed / total * 100)
        : 0;

    $("totalTasks").textContent = total;
    $("completedTasks").textContent = completed;
    $("pendingTasks").textContent = pending;
    $("completionRate").textContent = rate + "%";

    $("dashboardProgressText").textContent = rate + "%";
    $("dashboardProgressBar").style.width = rate + "%";

    $("dashboardMessage").textContent = total
        ? "Keep going! Your productivity is growing."
        : "Start adding tasks to track your productivity.";

    renderTasks("recentTasksList", tasks.slice(0, 5));
}

// ======================================
// CALENDAR
// ======================================

function displayCalendar() {
    const grid = $("calendarGrid");
    grid.innerHTML = "";

    const year = visibleMonth.getFullYear();
    const month = visibleMonth.getMonth();

    $("calendarMonth").textContent = visibleMonth.toLocaleDateString(
        "en-IN",
        { month: "long", year: "numeric" }
    );

    ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].forEach(day => {
        const label = document.createElement("div");
        label.className = "calendar-day-name";
        label.textContent = day;
        grid.append(label);
    });

    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    const today = dateKey(new Date());
    const selected = dateKey(selectedDate);

    for (let i = 0; i < firstDay; i++) {
        const empty = document.createElement("div");
        empty.className = "calendar-day muted";
        grid.append(empty);
    }

    for (let day = 1; day <= daysInMonth; day++) {
        const current = new Date(year, month, day);
        const key = dateKey(current);

        const dayTasks = tasks.filter(task => task.dueDate === key);

        const oldHistory = history.filter(record =>
            record.dueDate === key &&
            !tasks.some(task => task.id === record.taskId)
        );

        const cell = document.createElement("button");
        cell.type = "button";
        cell.className = "calendar-day";

        if (key === today) cell.classList.add("today");
        if (key === selected) cell.classList.add("selected");

        if (dayTasks.some(task => !task.completed)) {
            cell.classList.add("pending-day");
        } else if (dayTasks.length || oldHistory.length) {
            cell.classList.add("completed-day");
        }

        const number = document.createElement("span");
        number.className = "day-number";
        number.textContent = day;

        cell.append(number);

        const countValue = dayTasks.length + oldHistory.length;

        if (countValue > 0) {
            const count = document.createElement("span");
            count.className = "day-task-count";
            count.textContent = `${countValue} task${countValue > 1 ? "s" : ""}`;
            cell.append(count);
        }

        cell.addEventListener("click", () => {
            selectedDate = current;
            displayCalendar();
        });

        grid.append(cell);
    }

    displaySelectedDateTasks();
}

function displaySelectedDateTasks() {
    const key = dateKey(selectedDate);

    $("selectedDateHeading").textContent =
        selectedDate.toLocaleDateString("en-IN", {
            weekday: "long",
            day: "numeric",
            month: "long",
            year: "numeric"
        }) + " - Tasks";

    renderTasks(
        "selectedDateTasks",
        tasks.filter(task => task.dueDate === key)
    );
}

$("prevMonth").addEventListener("click", () => {
    visibleMonth.setMonth(visibleMonth.getMonth() - 1);
    displayCalendar();
});

$("nextMonth").addEventListener("click", () => {
    visibleMonth.setMonth(visibleMonth.getMonth() + 1);
    displayCalendar();
});

// ======================================
// ANALYTICS
// ======================================

function createChart(containerId, labels, values) {
    const container = $(containerId);
    container.innerHTML = "";

    const max = Math.max(...values, 1);

    labels.forEach((label, index) => {
        const row = document.createElement("div");
        row.className = "chart-row";

        const name = document.createElement("span");
        name.textContent = label;

        const track = document.createElement("div");
        track.className = "chart-track";

        const fill = document.createElement("div");
        fill.className = "chart-fill";
        fill.style.width = `${values[index] / max * 100}%`;

        const number = document.createElement("strong");
        number.textContent = values[index];

        track.append(fill);
        row.append(name, track, number);
        container.append(row);
    });
}

function displayAnalytics() {
    const total = tasks.length;
    const completed = tasks.filter(task => task.completed).length;

    const rate = total
        ? Math.round(completed / total * 100)
        : 0;

    $("analyticsTotal").textContent = total;
    $("analyticsRate").textContent = rate + "%";

    $("analyticsHigh").textContent = tasks.filter(
        task => task.priority === "High" && !task.completed
    ).length;

    $("analyticsOverdue").textContent =
        tasks.filter(isOverdue).length;

    const categories = ["Study", "Personal", "Work"];
    const priorities = ["High", "Medium", "Low"];

    createChart(
        "categoryChart",
        categories,
        categories.map(category =>
            tasks.filter(task => task.category === category).length
        )
    );

    createChart(
        "priorityChart",
        priorities,
        priorities.map(priority =>
            tasks.filter(task => task.priority === priority).length
        )
    );
}

// ======================================
// HISTORY
// ======================================

function displayHistory() {
    const sorted = [...history].sort((a, b) =>
        new Date(b.completedAt || 0) -
        new Date(a.completedAt || 0)
    );

    renderTasks("historyList", sorted, true);
}

// ======================================
// THEME
// ======================================

function applyTheme() {
    const theme = localStorage.getItem("taskoraTheme") || "dark";

    document.body.classList.toggle("light", theme === "light");

    $("themeToggle").innerHTML = theme === "light"
        ? "☾ <span>Toggle Theme</span>"
        : "☼ <span>Toggle Theme</span>";
}

$("themeToggle").addEventListener("click", () => {
    const current = localStorage.getItem("taskoraTheme") || "dark";

    localStorage.setItem(
        "taskoraTheme",
        current === "dark" ? "light" : "dark"
    );

    applyTheme();
    scheduleAutoFileSave();
});

// ======================================
// EXPORT BACKUP
// ======================================

$("exportBackup").addEventListener("click", () => {
    const blob = new Blob(
        [JSON.stringify(createBackupData(), null, 2)],
        { type: "application/json" }
    );

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = `taskora-backup-${dateKey(new Date())}.json`;

    document.body.append(link);
    link.click();
    link.remove();

    URL.revokeObjectURL(url);
});

// ======================================
// IMPORT BACKUP
// ======================================

$("importBackupButton").addEventListener("click", () => {
    const file = $("importBackup").files[0];

    if (!file) {
        alert("Please select a Taskora JSON backup file first.");
        return;
    }

    if (!confirm("This will replace your current tasks and history. Continue?")) {
        return;
    }

    const reader = new FileReader();

    reader.onload = event => {
        try {
            const data = JSON.parse(event.target.result);

            if (
                data.app !== "Taskora" ||
                !Array.isArray(data.tasks) ||
                !Array.isArray(data.history)
            ) {
                throw new Error("Invalid backup file.");
            }

            tasks = data.tasks.map(task => ({
                ...task,
                priority: ["High", "Medium", "Low"].includes(task.priority)
                    ? task.priority : "Medium",
                category: ["Study", "Personal", "Work"].includes(task.category)
                    ? task.category : "Personal",
                dueDate: typeof task.dueDate === "string" ? task.dueDate : "",
                description: typeof task.description === "string"
                    ? task.description : "",
                completed: Boolean(task.completed),
                completedAt: task.completedAt || null
            }));

            history = data.history;

            if (data.theme === "light" || data.theme === "dark") {
                localStorage.setItem("taskoraTheme", data.theme);
            }

            saveTasks();
            saveHistory();

            applyTheme();
            displayAll();

            $("importBackup").value = "";

            alert("Taskora backup restored successfully!");

        } catch (error) {
            console.error(error);
            alert("Invalid Taskora backup file.");
        }
    };

    reader.onerror = () => {
        alert("Could not read the selected file.");
    };

    reader.readAsText(file);
});

// ======================================
// DISPLAY ALL
// ======================================

function displayAll() {
    displayDashboard();
    renderTasks("taskList", getFilteredTasks());
    displayCalendar();
    displayAnalytics();
    displayHistory();

    $("taskCount").textContent =
        `${tasks.length} task${tasks.length !== 1 ? "s" : ""}`;
}

// ======================================
// INITIALIZATION
// ======================================

// Recover completed records if they are not already in history.
tasks.forEach(task => {
    if (
        task.completed &&
        !history.some(record => record.taskId === task.id)
    ) {
        history.unshift({
            taskId: task.id,
            name: task.name,
            category: task.category,
            priority: task.priority,
            dueDate: task.dueDate,
            description: task.description,
            completedAt: task.completedAt
        });
    }
});

saveTasks();
saveHistory();

$("todayLabel").textContent = new Date().toLocaleDateString("en-IN", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric"
});

$("taskDate").value = dateKey(new Date());

applyTheme();
displayAll();

restoreAutoSaveConnection();
