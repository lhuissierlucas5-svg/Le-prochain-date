import { h, api, toast, fmtDate } from "/js/dom.js";

const root = document.getElementById("root");
const ANSWER_LABEL = { liked: "Aimée", maybe: "Peut-être", disliked: "Refusée" };
const SLOT_LABEL = { semaine: "En semaine", weekend: "Le week-end", journee: "En journée", soiree: "En soirée" };

let invitations = [];
let defaults = { hostName: "Lucas", welcomeMessage: "" };

const linkFor = (inv) => `${location.origin}/i/${inv.token}`;
const current = () => invitations.find((i) => i.status === "active");

// --------------------------------------------------------------- modales ---
function modal(title, body) {
  const dlg = h("dialog", {}, h("h2", {}, title), body);
  dlg.addEventListener("close", () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}

function confirmDialog(title, message, okLabel) {
  return new Promise((resolve) => {
    let result = false;
    const dlg = modal(title, h("div", { class: "form" },
      h("p", {}, message),
      h("div", { class: "row" },
        h("button", { class: "btn", onclick: () => { result = true; dlg.close(); } }, okLabel),
        h("button", { class: "btn ghost", onclick: () => dlg.close() }, "Annuler"))));
    dlg.addEventListener("close", () => resolve(result));
  });
}

// ------------------------------------------------------------------ login --
function renderLogin(message = "") {
  const err = h("p", { class: "error", role: "alert" }, message);
  const pwd = h("input", { type: "password", autocomplete: "current-password", required: true, "aria-label": "Mot de passe" });
  root.replaceChildren(h("form", { class: "login form", onsubmit: async (e) => {
    e.preventDefault();
    try { await api("/api/admin/login", { method: "POST", body: { password: pwd.value } }); load(); }
    catch (ex) { err.textContent = ex.message; }
  } },
    h("h1", { style: { color: "var(--green)" } }, "Administration"),
    h("p", { class: "sub" }, "Le prochain date"),
    pwd, err, h("button", { class: "btn", type: "submit" }, "Se connecter")));
  pwd.focus();
}

// -------------------------------------------------------------- données ----
async function load() {
  try {
    const data = await api("/api/admin/invitations");
    invitations = data.invitations;
    defaults = data.defaults;
  } catch (e) {
    if (e.status === 401) return renderLogin();
    return toast(e.message);
  }
  render();
}

function replaceInv(updated) {
  invitations = invitations.map((i) => (i.id === updated.id ? updated : i));
  render();
}

// ----------------------------------------------------------------- shell ---
function route() { return location.hash.replace(/^#\/?/, "") || "current"; }

function render() {
  const r = route();
  const tab = r.startsWith("responses/") ? "" : r;
  const nav = h("nav", { class: "tabs" },
    h("a", { href: "#/current", "aria-current": tab === "current" ? "page" : null }, "Invitation actuelle"),
    h("a", { href: "#/history", "aria-current": tab === "history" ? "page" : null }, `Historique (${invitations.filter((i) => i.status === "archived").length})`));
  let view;
  if (r.startsWith("responses/")) view = responsesView(invitations.find((i) => i.id === r.split("/")[1]));
  else if (r === "history") view = historyView();
  else view = currentView();

  root.replaceChildren(h("div", { class: "wrap" },
    h("header", { class: "bar" },
      h("h1", {}, "Le prochain date"),
      h("button", { class: "btn ghost sm", onclick: async () => { await api("/api/admin/logout", { method: "POST", body: {} }); renderLogin(); } }, "Déconnexion")),
    nav, view));
}
window.addEventListener("hashchange", () => root.querySelector(".wrap") && render());

// ------------------------------------------------------- formulaire invit. -
function invitationForm(inv, onDone) {
  const f = {
    recipientName: h("input", { type: "text", maxlength: 60, required: true, value: inv?.recipientName || "", placeholder: "Émilie" }),
    hostName: h("input", { type: "text", maxlength: 60, required: true, value: inv?.hostName || defaults.hostName }),
    region: h("input", { type: "text", maxlength: 80, value: inv?.region || "", placeholder: "Ex. Nantes, Côte basque…" }),
    welcomeMessage: h("textarea", { maxlength: 300 }, inv?.welcomeMessage || defaults.welcomeMessage),
  };
  const err = h("p", { class: "error", role: "alert" });
  return h("form", { class: "form", novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    err.textContent = "";
    const body = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value]));
    if (!body.recipientName.trim()) return (err.textContent = "Le prénom est obligatoire.");
    if (!body.hostName.trim()) return (err.textContent = "Ton prénom est obligatoire.");
    try { await onDone(body); } catch (ex) { err.textContent = ex.message; }
  } },
    h("div", { class: "grid2" },
      h("label", {}, "Prénom de la personne", f.recipientName),
      h("label", {}, "Ton prénom (affiché à la personne)", f.hostName)),
    h("label", {}, "Région ou ville", f.region),
    h("label", {}, "Message d'accueil", f.welcomeMessage,
      h("span", { class: "hint" }, "Utilise {name} pour le prénom et {host} pour le tien.")),
    err,
    h("button", { class: "btn", type: "submit" }, inv ? "Enregistrer" : "Créer l'invitation"));
}

async function createInvitation(body) {
  const created = await api("/api/admin/invitations", { method: "POST", body });
  invitations = invitations.map((i) => (i.status === "active" ? { ...i, status: "archived" } : i));
  invitations.unshift(created);
  location.hash = "#/current";
  render();
  toast("Invitation créée. Il ne reste qu'à copier le lien !");
}

// ------------------------------------------------------ invitation actuelle -
function currentView() {
  const inv = current();
  if (!inv) {
    return h("div", { class: "card-a" },
      h("div", { class: "empty" },
        h("h2", {}, "Aucune invitation pour le moment"),
        h("p", {}, "Crée une invitation pour générer un lien personnel à envoyer.")),
      invitationForm(null, createInvitation));
  }
  const s = inv.stats;
  const input = h("input", { type: "text", readonly: true, value: linkFor(inv), "aria-label": "Lien personnalisé", onfocus: (e) => e.target.select() });
  const copy = h("button", { class: "btn sm", onclick: async () => {
    try { await navigator.clipboard.writeText(linkFor(inv)); } catch { input.select(); document.execCommand("copy"); }
    toast("Lien copié ✓");
  } }, "Copier le lien");

  const editBox = h("div", { hidden: true, style: { marginTop: "1rem" } }, invitationForm(inv, async (body) => {
    replaceInv(await api(`/api/admin/invitations/${inv.id}`, { method: "PUT", body }));
    toast("Modifications enregistrées ✓");
  }));

  const newBox = h("div", { class: "card-a", hidden: true },
    h("h3", {}, "Nouvelle invitation"),
    h("p", { class: "sub", style: { marginBottom: ".8rem" } }, `L'invitation de ${inv.recipientName} sera archivée et son lien ne fonctionnera plus.`),
    invitationForm(null, async (body) => {
      if (!(await confirmDialog("Archiver l'invitation actuelle ?", `L'invitation de ${inv.recipientName} sera archivée : son lien cessera de fonctionner, ses réponses restent consultables dans l'historique.`, "Archiver et créer"))) return;
      await createInvitation(body);
    }));

  return h("div", {},
    h("div", { class: "card-a" },
      h("div", { class: "row between" },
        h("div", {}, h("h2", {}, inv.recipientName), h("p", { class: "sub" }, `${inv.region || "Région non précisée"} · créée le ${fmtDate(inv.createdAt)}`)),
        h("span", { class: "badge active" }, "Active")),
      h("div", { class: "stats" },
        stat(s.liked, "aimées"), stat(s.maybe, "peut-être"), stat(s.disliked, "refusées")),
      inv.preference && h("p", { class: "sub" }, "💬 « ", inv.preference, " »"),
      h("div", { class: "linkbox" }, input, copy),
      h("div", { class: "row" },
        h("a", { class: "btn sm", href: `#/responses/${inv.id}`, style: { textDecoration: "none" } }, "Voir les réponses"),
        h("button", { class: "btn ghost sm", onclick: () => (editBox.hidden = !editBox.hidden) }, "Modifier"),
        h("button", { class: "btn danger sm", onclick: async () => {
          if (await confirmDialog("Archiver cette invitation ?", `Le lien de ${inv.recipientName} cessera de fonctionner. Les réponses restent consultables dans l'historique.`, "Archiver")) {
            replaceInv(await api(`/api/admin/invitations/${inv.id}/archive`, { method: "POST", body: {} }));
            toast("Invitation archivée.");
          }
        } }, "Archiver"),
        h("button", { class: "btn ghost sm", onclick: () => (newBox.hidden = !newBox.hidden) }, "Nouvelle invitation")),
      editBox),
    newBox,
    ideasCard(inv));
}

const stat = (n, label) => h("div", { class: "stat" }, h("b", {}, String(n)), h("span", {}, label));

// ------------------------------------------------------------------ idées --
function ideasCard(inv) {
  return h("div", { class: "card-a" },
    h("div", { class: "row between", style: { marginBottom: ".8rem" } },
      h("div", {}, h("h2", {}, "Idées de rendez-vous"), h("p", { class: "sub" }, `${inv.ideas.filter((i) => i.active).length} active(s) sur ${inv.ideas.length}`)),
      h("button", { class: "btn sm", onclick: () => ideaDialog(inv, null) }, "+ Ajouter une idée")),
    inv.ideas.length === 0
      ? h("p", { class: "empty" }, "Aucune idée pour l'instant. Ajoutes-en une pour que la personne ait quelque chose à parcourir.")
      : h("div", { class: "ideas" }, inv.ideas.map((idea) => h("div", { class: `idea${idea.active ? "" : " off"}` },
        h("div", { class: "thumb", style: { backgroundImage: `url("${idea.image}")` } }),
        h("div", { class: "info" }, h("b", {}, idea.title), h("span", {}, idea.description), idea.meta && h("span", {}, idea.meta)),
        h("div", { class: "ctrl" },
          h("button", { class: "btn ghost sm", onclick: async () => {
            replaceInv(await api(`/api/admin/invitations/${inv.id}/ideas/${idea.id}`, { method: "PUT", body: { ...idea, active: !idea.active } }));
          } }, idea.active ? "Désactiver" : "Activer"),
          h("button", { class: "btn ghost sm", onclick: () => ideaDialog(inv, idea) }, "Modifier"),
          h("button", { class: "btn danger sm", onclick: async () => {
            if (await confirmDialog("Supprimer cette idée ?", `« ${idea.title} » sera supprimée de l'invitation.`, "Supprimer")) {
              replaceInv(await api(`/api/admin/invitations/${inv.id}/ideas/${idea.id}`, { method: "DELETE" }));
            }
          } }, "Supprimer"))))));
}

function resizeImage(file, max = 1200) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = h("canvas", {});
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => reject(new Error("Image illisible."));
    img.src = URL.createObjectURL(file);
  });
}

function ideaDialog(inv, idea) {
  const f = {
    title: h("input", { type: "text", maxlength: 80, value: idea?.title || "" }),
    description: h("textarea", { maxlength: 400 }, idea?.description || ""),
    todo: h("textarea", { maxlength: 1200 }, (idea?.todo || []).join("\n")),
    meta: h("input", { type: "text", maxlength: 60, value: idea?.meta || "", placeholder: "15 à 30 € · 2 h" }),
    image: h("input", { type: "text", maxlength: 500, value: idea?.image || "", placeholder: "https://… ou envoie un fichier" }),
  };
  const active = h("input", { type: "checkbox", checked: idea ? idea.active : true });
  const preview = h("div", { class: "preview" });
  const showPreview = () => (preview.style.backgroundImage = f.image.value ? `url("${f.image.value}")` : "");
  f.image.addEventListener("input", showPreview); showPreview();
  const file = h("input", { type: "file", accept: "image/*", "aria-label": "Envoyer une image", onchange: async () => {
    if (!file.files[0]) return;
    try {
      const { url } = await api("/api/admin/upload", { method: "POST", body: { dataUrl: await resizeImage(file.files[0]) } });
      f.image.value = url; showPreview();
    } catch (ex) { err.textContent = ex.message; }
  } });
  const err = h("p", { class: "error", role: "alert" });

  const dlg = modal(idea ? "Modifier l'idée" : "Nouvelle idée", h("form", { class: "form", novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    err.textContent = "";
    if (!f.title.value.trim()) return (err.textContent = "Le titre est obligatoire.");
    if (!f.description.value.trim()) return (err.textContent = "La description est obligatoire.");
    const body = { title: f.title.value, description: f.description.value, todo: f.todo.value, meta: f.meta.value, image: f.image.value, active: active.checked };
    try {
      const path = `/api/admin/invitations/${inv.id}/ideas${idea ? "/" + idea.id : ""}`;
      replaceInv(await api(path, { method: idea ? "PUT" : "POST", body }));
      dlg.close();
    } catch (ex) { err.textContent = ex.message; }
  } },
    h("label", {}, "Titre", f.title),
    h("label", {}, "Description", f.description),
    h("label", {}, "À faire sur place", f.todo, h("span", { class: "hint" }, "Une idée par ligne.")),
    h("label", {}, "Budget ou durée", f.meta),
    preview,
    h("label", {}, "Image (lien)", f.image),
    h("label", {}, "…ou envoyer un fichier", file),
    h("label", { class: "check" }, active, "Idée active (visible par la personne)"),
    err,
    h("div", { class: "row" },
      h("button", { class: "btn", type: "submit" }, "Enregistrer"),
      h("button", { class: "btn ghost", type: "button", onclick: () => dlg.close() }, "Annuler"))));
}

// ------------------------------------------------------------- historique --
function historyView() {
  const past = invitations.filter((i) => i.status === "archived");
  if (!past.length) return h("div", { class: "card-a empty" }, h("h2", {}, "Rien dans l'historique"), h("p", {}, "Les invitations archivées apparaîtront ici."));
  return h("div", {}, past.map((inv) => h("div", { class: "card-a" },
    h("div", { class: "row between" },
      h("div", {}, h("h2", {}, inv.recipientName), h("p", { class: "sub" }, `${inv.region || "—"} · créée le ${fmtDate(inv.createdAt)}`)),
      h("span", { class: "badge archived" }, "Archivée")),
    h("div", { class: "stats" }, stat(inv.stats.liked, "aimées"), stat(inv.stats.maybe, "peut-être"), stat(inv.stats.disliked, "refusées")),
    inv.preference && h("p", { class: "sub", style: { marginBottom: ".8rem" } }, "💬 « ", inv.preference, " »"),
    h("div", { class: "row" },
      h("a", { class: "btn sm", href: `#/responses/${inv.id}`, style: { textDecoration: "none" } }, "Voir les réponses"),
      h("button", { class: "btn danger sm", onclick: async () => {
        if (await confirmDialog("Supprimer définitivement ?", `L'invitation de ${inv.recipientName} et toutes ses réponses seront supprimées. Cette action est irréversible.`, "Supprimer")) {
          await api(`/api/admin/invitations/${inv.id}`, { method: "DELETE" });
          invitations = invitations.filter((i) => i.id !== inv.id);
          render();
        }
      } }, "Supprimer")))));
}

// --------------------------------------------------------------- réponses --
function responsesView(inv) {
  if (!inv) return h("div", { class: "card-a empty" }, h("h2", {}, "Invitation introuvable"), h("a", { href: "#/current" }, "Retour"));
  const rs = [...inv.responses].sort((a, b) => a.at.localeCompare(b.at));
  const titles = (answer) => rs.filter((r) => r.answer === answer).map((r) => h("li", {}, r.ideaTitle));
  const score = { liked: 2, maybe: 1, disliked: 0 };
  const ranked = [...rs].sort((a, b) => score[b.answer] - score[a.answer]).filter((r) => r.answer !== "disliked").slice(0, 3);

  return h("div", {},
    h("p", {}, h("a", { href: inv.status === "active" ? "#/current" : "#/history" }, "← Retour")),
    h("div", { class: "card-a" },
      h("div", { class: "row between" },
        h("div", {}, h("h2", {}, `Réponses de ${inv.recipientName}`), h("p", { class: "sub" }, `${rs.length} réponse(s) · modifiée le ${fmtDate(inv.updatedAt)}`)),
        h("a", { class: "btn ghost sm", href: `/api/admin/invitations/${inv.id}/export.csv`, style: { textDecoration: "none" } }, "Exporter en CSV"))),
    rs.length === 0
      ? h("div", { class: "card-a empty" }, h("h2", {}, "Pas encore de réponse"), h("p", {}, `${inv.recipientName} n'a pas encore commencé. Envoie-lui le lien !`))
      : h("div", {},
        h("div", { class: "card-a synth" },
          h("div", {}, h("h3", {}, "Activités préférées"), h("ul", {}, titles("liked").length ? titles("liked") : h("li", {}, "—"))),
          h("div", {}, h("h3", {}, "À éviter"), h("ul", {}, titles("disliked").length ? titles("disliked") : h("li", {}, "—"))),
          h("div", {}, h("h3", {}, "Suggestions les mieux notées"),
            h("ul", { class: "rank" }, ranked.length ? ranked.map((r) => h("li", {}, r.ideaTitle, h("span", { class: `badge ${r.answer}` }, ANSWER_LABEL[r.answer]))) : h("li", {}, "—"))),
          h("div", {}, h("h3", {}, "Total"), h("p", {}, `${rs.length} réponse(s) : ${inv.stats.liked} aimée(s), ${inv.stats.maybe} peut-être, ${inv.stats.disliked} refusée(s).`))),
        h("div", { class: "card-a" }, h("h3", {}, "Détail"), rs.map((r) => h("div", { class: "resp" },
          h("div", { class: "thumb", style: { backgroundImage: `url("${r.ideaImage}")` } }),
          h("div", { class: "info" }, h("b", {}, r.ideaTitle), h("small", {}, fmtDate(r.at))),
          h("span", { class: `badge ${r.answer}` }, ANSWER_LABEL[r.answer]))))),
    h("div", { class: "card-a" },
      h("h3", {}, "Disponibilités"),
      inv.availability.length
        ? h("div", { class: "row" }, inv.availability.map((s) => h("span", { class: "badge" }, SLOT_LABEL[s])))
        : h("p", { class: "sub" }, "Pas encore renseignées.")),
    h("div", { class: "card-a" },
      h("h3", {}, "Commentaire / préférences"),
      inv.preference ? h("p", {}, inv.preference) : h("p", { class: "sub" }, "Aucun commentaire pour l'instant.")));
}

load();
