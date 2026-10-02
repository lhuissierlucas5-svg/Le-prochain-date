import { h, api, toast } from "/js/dom.js";

const token = location.pathname.split("/").filter(Boolean)[1];
const app = document.getElementById("app");
const SLOTS = [["semaine", "En semaine"], ["weekend", "Le week-end"], ["journee", "En journée"], ["soiree", "En soirée"]];

let inv;            // invitation publique
let ideas = [];     // idées actives
let answers = {};   // ideaId -> answer
let index = 0;
let busy = false;

const vars = () => ({ name: inv.recipientName, host: inv.hostName, region: inv.region });

function welcomeTitle() {
  // Le prénom vient des données ; on le met en valeur sans jamais l'écrire en dur.
  return inv.welcomeMessage.split(/(\{\w+\})/).map((part) => {
    const m = part.match(/^\{(\w+)\}$/);
    if (!m) return part;
    const v = vars()[m[1]];
    if (v == null) return part;
    return m[1] === "name" ? h("em", {}, v) : v;
  });
}

function show(...nodes) {
  app.replaceChildren(...nodes);
  window.scrollTo(0, 0);
}

// -------------------------------------------------------------- accueil ----
function renderWelcome() {
  document.title = `Pour ${inv.recipientName} · Le prochain date`;
  show(h("section", { class: "screen welcome" },
    h("div", { class: "blob", "aria-hidden": "true" }),
    h("p", { class: "eyebrow" }, "Le prochain date"),
    h("h1", {}, welcomeTitle()),
    h("p", { class: "warm" }, "Quelques idées, aucune pression, et peut-être une jolie surprise à la clé."),
    h("div", {}, h("button", { class: "btn", onclick: startSwipe }, "Oui, c'est parti !")),
  ));
}

// ---------------------------------------------------------------- cartes ---
function startSwipe() {
  index = ideas.findIndex((i) => !answers[i.id]);
  if (index === -1) return renderRecap();
  renderSwipe();
}

function cardEl(idea, role) {
  const card = h("article", { class: `card ${role}`, "aria-hidden": role === "next" ? "true" : null },
    h("div", { class: "card-img", style: { backgroundImage: `url("${idea.image}")` } },
      role === "top" && h("span", { class: "stamp like" }, "J'aime"),
      role === "top" && h("span", { class: "stamp nope" }, "Bof"),
      role === "top" && h("span", { class: "stamp maybe" }, "À voir"),
      h("h2", {}, idea.title)),
    h("div", { class: "card-body" },
      h("p", {}, idea.description),
      idea.todo.length > 0 && h("ul", {}, idea.todo.map((t) => h("li", {}, t))),
      idea.meta && h("span", { class: "meta" }, idea.meta)));
  return card;
}

function renderSwipe() {
  const total = ideas.length;
  const idea = ideas[index];
  const next = ideas[index + 1];

  const deck = h("div", { class: "deck" });
  if (next) deck.append(cardEl(next, "next"));
  const top = cardEl(idea, "top");
  deck.append(top);
  attachDrag(top);

  const label = h("span", {}, `Idée ${index + 1} sur ${total}`);
  const bar = h("i", { style: { width: `${(index / total) * 100}%` } });
  requestAnimationFrame(() => (bar.style.width = `${((index + 1) / total) * 100}%`));

  show(h("section", { class: "screen" },
    h("div", { class: "topbar" },
      h("div", { class: "progress-label" }, label, h("span", {}, `Pour ${inv.recipientName}`)),
      h("div", { class: "progress", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": total, "aria-valuenow": index + 1 }, bar)),
    deck,
    h("div", { class: "actions" },
      h("button", { class: "round", "aria-label": "Pas vraiment", onclick: () => decide("disliked") }, "✕"),
      h("button", { class: "round maybe", "aria-label": "Pourquoi pas", onclick: () => decide("maybe") }, "Pourquoi pas"),
      h("button", { class: "round like", "aria-label": "J'aime", onclick: () => decide("liked") }, "♥")),
    h("p", { class: "hint" }, "Glisse la carte à droite si ça te plaît, à gauche sinon."),
  ));
}

const FLY = { liked: [1, 0], disliked: [-1, 0], maybe: [0, -1] };

function decide(answer) {
  if (busy) return;
  const card = app.querySelector(".card.top");
  if (!card) return;
  busy = true;
  const [fx, fy] = FLY[answer];
  card.classList.remove("snap");
  card.classList.add("leaving");
  card.style.transform = `translate(${fx * 120}vw, ${fy * 60}vh) rotate(${fx * 18}deg)`;

  const idea = ideas[index];
  answers[idea.id] = answer;
  api(`/api/invite/${token}/answer`, { method: "POST", body: { ideaId: idea.id, answer } })
    .catch(() => toast("Réponse non enregistrée, vérifie ta connexion."));

  setTimeout(() => {
    busy = false;
    index += 1;
    index < ideas.length ? renderSwipe() : renderRecap();
  }, 330);
}

function attachDrag(card) {
  let sx = 0, sy = 0, dragging = false;
  const stamps = { like: card.querySelector(".stamp.like"), nope: card.querySelector(".stamp.nope"), maybe: card.querySelector(".stamp.maybe") };

  card.addEventListener("pointerdown", (e) => {
    if (busy || e.target.closest("a,button")) return;
    dragging = true; sx = e.clientX; sy = e.clientY;
    card.classList.remove("snap");
    card.setPointerCapture(e.pointerId);
  });
  card.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - sx, dy = Math.min(0, e.clientY - sy) * 0.5;
    card.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx / 22}deg)`;
    stamps.like.style.opacity = Math.max(0, Math.min(1, dx / 90));
    stamps.nope.style.opacity = Math.max(0, Math.min(1, -dx / 90));
    stamps.maybe.style.opacity = Math.abs(dx) < 60 ? Math.max(0, Math.min(1, -(e.clientY - sy) / 110)) : 0;
  });
  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (dx > 100) return decide("liked");
    if (dx < -100) return decide("disliked");
    if (dy < -120 && Math.abs(dx) < 70) return decide("maybe");
    card.classList.add("snap");
    card.style.transform = "";
    Object.values(stamps).forEach((s) => (s.style.opacity = 0));
  };
  card.addEventListener("pointerup", end);
  card.addEventListener("pointercancel", end);
}

document.addEventListener("keydown", (e) => {
  if (!app.querySelector(".card.top") || /TEXTAREA|INPUT/.test(document.activeElement.tagName)) return;
  if (e.key === "ArrowRight") decide("liked");
  else if (e.key === "ArrowLeft") decide("disliked");
  else if (e.key === "ArrowUp") decide("maybe");
});

// ------------------------------------------------------------- récapitulatif
function renderRecap() {
  const liked = ideas.filter((i) => answers[i.id] === "liked");
  const maybe = ideas.filter((i) => answers[i.id] === "maybe");
  const item = (i) => h("div", { class: "liked-item" },
    h("div", { class: "thumb", style: { backgroundImage: `url("${i.image}")` } }),
    h("span", {}, i.title, i.meta && h("small", {}, i.meta)));

  const slots = new Set(inv.availability);
  const saved = h("p", { class: "saved", "aria-live": "polite" });
  let saveTimer;
  const chips = SLOTS.map(([key, label]) => h("button", {
    class: "chip", type: "button", "aria-pressed": String(slots.has(key)),
    onclick: (e) => {
      slots.has(key) ? slots.delete(key) : slots.add(key);
      e.currentTarget.setAttribute("aria-pressed", String(slots.has(key)));
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => api(`/api/invite/${token}/availability`, { method: "POST", body: { slots: [...slots] } })
        .then(() => (saved.textContent = "Disponibilités enregistrées ✓"))
        .catch(() => toast("Impossible d'enregistrer pour le moment.")), 400);
    },
  }, label));

  const prefBox = h("textarea", { maxlength: 1000, placeholder: "Une allergie, une envie, un truc que tu adores (ou pas)…", "aria-label": "Ta préférence" }, inv.preference);
  const prefSaved = h("p", { class: "saved", "aria-live": "polite" });
  const prefPanel = h("div", { class: "panel", hidden: !inv.preference },
    prefBox,
    h("button", { class: "btn green", type: "button", onclick: async () => {
      try {
        await api(`/api/invite/${token}/preference`, { method: "POST", body: { text: prefBox.value } });
        inv.preference = prefBox.value;
        prefSaved.textContent = "Merci, c'est noté ✓";
      } catch { toast("Impossible d'enregistrer pour le moment."); }
    } }, "Enregistrer"),
    prefSaved);

  show(h("section", { class: "screen recap" },
    h("div", {},
      h("h1", {}, `Merci pour tes réponses, ${inv.recipientName} !`),
      h("p", { class: "lead" }, liked.length ? "Voilà ce qui t'a donné envie :" : "On a bien noté tes envies.")),
    liked.length
      ? h("div", {}, h("div", { class: "liked-list" }, liked.map(item)))
      : h("p", { class: "empty-note" }, "Aucune idée ne t'a vraiment séduite, et c'est très bien comme ça."),
    maybe.length > 0 && h("div", {}, h("h3", {}, "Peut-être"), h("div", { class: "liked-list" }, maybe.map(item))),
    h("div", { class: "panel" },
      h("h3", {}, "Quand es-tu disponible ?"),
      h("div", { class: "chips" }, chips), saved),
    h("div", {},
      h("button", { class: "btn ghost", type: "button", onclick: () => { prefPanel.hidden = !prefPanel.hidden; if (!prefPanel.hidden) prefBox.focus(); } },
        "Ajouter une préférence"),
      h("div", { style: { marginTop: ".8rem" } }, prefPanel)),
    h("p", { class: "closing" }, `${inv.hostName} va jeter un œil à tes réponses et prépare la suite. À très vite !`),
  ));
}

// ----------------------------------------------------------------- démarrage
function note(title, text) {
  show(h("section", { class: "screen" }, h("div", { class: "center-note" }, h("h1", {}, title), h("p", {}, text))));
}

(async () => {
  try {
    inv = await api(`/api/invite/${token}`);
  } catch (err) {
    return err.status === 410
      ? note("Cette invitation est terminée", "Merci d'être passé par ici.")
      : note("Lien introuvable", "Vérifie le lien que tu as reçu.");
  }
  ideas = inv.ideas;
  answers = Object.fromEntries(inv.responses.map((r) => [r.ideaId, r.answer]));
  if (!ideas.length) return note("Bientôt !", `${inv.hostName} prépare encore quelques idées.`);
  const answered = ideas.filter((i) => answers[i.id]).length;
  if (answered === ideas.length) renderRecap();
  else if (answered > 0) startSwipe();
  else renderWelcome();
})();
