# CapCut Subtitle Editor — MacBook Guide 🍎

Sirf **Mac (MacBook / iMac)** ke liye complete guide — install, run, build, aur common
errors ka fix. Windows ke liye `INSTALL-GUIDE.md` dekho.

---

## 0. One-time requirement: Node.js

App chalane se pehle **Node.js (LTS — v18 ya naya)** install hona chahiye.

- Download: **https://nodejs.org** → "LTS" install karo.
- Check karo Terminal me:
  ```bash
  node --version
  npm --version
  ```
  Version dikhe → ready ho.

> Tip: bahut **naye/odd Node versions (jaise v25)** ke saath kabhi-kabhi Electron
> download issues aate hain. Sabse safe hai **LTS (v20 ya v22)**.

---

## 1. ZIP extract karo

`CapCut-Subtitle-Editor-Source.zip` par double-click → folder ban jayega.

> ⚠️ Folder ko **iCloud / Dropbox / OneDrive** synced location me mat rakho
> (Desktop/Documents agar iCloud par hain to bhi). Sync Electron binary ko
> corrupt kar deta hai. Best jagah: `~/Downloads` ya `~/dev/`.

---

## 2. Folder me Terminal kholo

Folder ko right-click → **New Terminal at Folder**
(ya Terminal khol ke `cd ` type karke folder drag-drop karo, phir Enter).

---

## 3. Dependencies install karo

```bash
npm install
```

Pehli baar thoda time lega (Electron ~100MB download hota hai). Jab tak
"added ... packages" na dikhe, wait karo.

---

## 4. App chalao (test)

```bash
npm start
```

App ki window khul jayegi. ✅

---

## 5. Installer (.dmg) banao — 2 tarike

**Tarika A (aasan):** folder me diya hua script double-click karo → `build-mac.command`
> Pehli baar Terminal me ek baar:
> ```bash
> chmod +x build-mac.command
> ```
> "unidentified developer" aaye → right-click → **Open** → **Open**.

**Tarika B (manual):**
```bash
npm run dist:mac
```

Ban jane ke baad installer yahan milega:
`dist/CapCut Subtitle Editor-1.0.0.dmg`

`.dmg` khol ke app ko **Applications** me drag karo. Pehli baar (unsigned app):
app par **right-click → Open → Open**, ya **System Settings → Privacy & Security → Open Anyway**.

> Note: `.dmg` sirf **Mac** par banta hai, aur jis Mac par build karo uska hi
> architecture (Apple Silicon / Intel) match karta hai.

---

## 🛠️ Troubleshooting (Mac-specific)

### A. `Electron exited with signal SIGKILL`
macOS ne Electron binary ko forcibly kill kiya. Matlab binary corrupt/quarantined hai.
**Fix — clean reinstall:**
```bash
rm -rf node_modules package-lock.json
npm cache clean --force
npm install
npm start
```

### B. `spawn ... Electron ENOENT`
Electron ka asli binary download hi nahi hua (ya delete ho gaya).
**Fix:**
```bash
rm -rf node_modules package-lock.json
npm install
# agar phir bhi na aaye:
node node_modules/electron/install.js
npm start
```
Binary check karo:
```bash
ls -la node_modules/electron/dist/Electron.app/Contents/MacOS/Electron
```

### C. ⚠️ "Malware Blocked and Moved to Bin — Electron.app" (सबसे important)
Yeh macOS **XProtect** ka **false-positive** hai — purani Electron version ke stock
binary ko galti se malware samajh ke Bin me daal deta hai. Isi wajah se app har baar
crash hota hai (binary delete ho jata hai).

**Fix (protection disable kiye bina):**
1. **macOS fully update karo** →  → System Settings → General → Software Update.
   (Yeh XProtect ki definitions update karta hai — Apple isi tarah false-positive theek karta hai.) Reboot.
2. **Electron latest version par le jao:**
   ```bash
   rm -rf node_modules package-lock.json
   npm install --save-dev electron@latest
   npm start
   ```

> Agar **fully-updated Mac par bhi** malware warning aaye, to force-open **mat** karo —
> tab binary ko seriously verify karna chahiye. Sirf fresh `npm install` se hi Electron
> laao, kisi doosre machine se `node_modules` copy mat karo.

### D. App khulti hai par projects nahi dikhte
CapCut me local drafts hone chahiye:
`~/Movies/CapCut/User Data/Projects/com.lveditor.draft`

---

## Quick command reference

| Kaam | Command |
|------|---------|
| Dependencies install | `npm install` |
| App run (test)       | `npm start` |
| Mac installer (.dmg) | `npm run dist:mac` |
| Clean reinstall      | `rm -rf node_modules package-lock.json && npm install` |
| Electron latest      | `npm install --save-dev electron@latest` |
