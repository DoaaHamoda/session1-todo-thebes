# Noted! - Todo DApp on Thebes / Internet Computer

A minimal, beautiful Todo / Noted DApp built with Motoko backend and vanilla JS frontend 
that talks directly to the chain via `POST /api/query` and `/api/call` (hex-encoded Candid).

### ✨ Features | المميزات

- **Add / Edit / Delete** notes with on-chain persistence
- **Timestamp** for each note - `6/26/2025, 6:38:35 PM` like in screenshot
- **Toggle Complete** with checkbox
- **Edit Modal** outside the LIST section (fixed overlay, not clipped)
- **Light / Dark / Auto Theme** with per-canister localStorage key
- **No build step** - pure HTML/CSS/JS


### 🏗️ Project Structure
```
session1/
├── backend/
│   └── Backend.mo      # persistent actor with id, text, completed, timestamp
├── frontend/
│   ├── index.html      # contains #edit-modal outside the .card LIST
│   ├── style.css       # .todo, .btn-pin, .btn-del, .modal
│   └── app.js          # manual Candid codec (uleb/sleb, hex, DIDL)
└── thebes.toml / dfx.json
```

### 🔧 Backend.mo - Final Version
```motoko
import Array "mo:core/Array";
import Time "mo:core/Time";

persistent actor {
  type Todo = { id: Nat; text: Text; completed: Bool; timestamp: Int; };
  var todos : [Todo] = [];
  var nextId : Nat = 0;

  public query func getTodos() : async [Todo] { todos };

  public func addTodo(text: Text) : async Todo {
    let todo = { id = nextId; text = text; completed = false; timestamp = Time.now() };
    nextId += 1; todos := Array.concat(todos, [todo]); todo
  };

  public func toggleTodo(id: Nat) : async Bool { /* ... */ true };
  public func deleteTodo(id: Nat) : async Bool { /* ... */ true };
  public func editTodo(id: Nat, newText: Text) : async Bool { /* ... */ true };
};
```
### 📸 Frontends — open in a browser:
 https://memphis.mercaturaforum.com/_/raw/87394868707133/index.html

### 🎨 Timestamp Styling
To make date/time bigger and colored:
```javascript
const time = document.createElement("small");
time.textContent = formatTimestamp(todo.timestamp);
time.style.fontSize = "13px";
time.style.fontWeight = "600";
time.style.color = "#8ab4f8"; // change to #f0a500 or #ff8fab
```

### 🚀 How to Deploy on Thebes
```bash
# install thebes cli
# then from project root
thebes-deploy deploy --upgrade

# canister id example: 158344202516175
# frontend will be at: https://<cid>._.raw.thebes.network
```

### 🖥️ Local Dev
Just open `frontend/index.html` via the boundary, no `npm` needed. The frontend uses:
- `BASE = ""` (same-origin)
- `demoSender()` per-browser sender scoped by canister id
- `fetchWithRetry` for transient 502 handling

Made by Doaa - with ❤️ for ICP/Thebes
