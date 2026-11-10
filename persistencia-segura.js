/* ─────────────────────────────────────────────────────────────────────────
   persistencia-segura.js · v1.1

   Guardado seguro para herramientas HTML de un solo archivo que conservan el
   trabajo del usuario en localStorage y, opcionalmente, en un archivo local
   mediante la File System Access API.

   Implementa las tres guardas descritas en el README:
     1. una lectura fallida nunca termina en escritura,
     2. nunca se escribe un estado vacío sobre un archivo con contenido,
     3. una sola pestaña a la vez,
   más el respaldo rotativo previo a cada escritura.

   Uso: cópialo dentro del <script> de tu herramienta (es un archivo de un solo
   archivo, al fin y al cabo) o cárgalo con <script src="persistencia-segura.js">.
   No tiene dependencias y no toca el DOM: los avisos y el repintado los pones tú.
   ───────────────────────────────────────────────────────────────────────── */
(function (global) {
"use strict";

function crearPersistencia(cfg) {

  /* ── configuración ────────────────────────────────────────────────────
     Los cuatro primeros son obligatorios en la práctica: sin ellos la
     librería no puede distinguir «no hay nada que perder» de «hay trabajo
     encima», que es la única pregunta que importa antes de escribir. */
  const C = Object.assign({
    clave:        "app_v1",            // prefijo de localStorage e IndexedDB
    estado:       () => ({}),          // devuelve el estado en memoria
    cargarEstado: (d) => {},           // aplica un estado leído del archivo
    estadoVacio:  () => true,          // ¿la pantalla no tiene trabajo del usuario?
    datosVacios:  (d) => !d,           // ¿el objeto leído no tiene trabajo?
    validar:      (d) => !!d,          // ¿este JSON es de esta herramienta?
    resumen:      (d) => "contenido",  // texto corto para los avisos

    /* aviso(titulo, htmlCuerpo) debe abrir una capa que el usuario cierre a
       propósito. El alert() de aquí es solo el último recurso: se descarta con
       Enter sin leerse, que es justo lo que no se quiere para un mensaje que
       evita una pérdida de datos. */
    aviso:  (titulo, html) => global.alert(titulo),
    marcar: (texto, tono) => {},       // píldora de estado de tu interfaz
    render: () => {},                  // repintar tras desvincular o cargar

    /* Opcional: devuelve la firma de contenido con la que se compara un
       respaldo contra el anterior. Úsala para excluir marcas de hora, para que
       guardar dos veces lo mismo no gaste una ranura. */
    clavePorContenido: null,

    maxRespaldos:    3,
    debounceLocal:   450,              // ms desde el último cambio al localStorage
    debounceArchivo: 600,              // ms extra antes de escribir el archivo
    caducaPestana:   90000,            // ms de validez del latido de otra pestaña
    nombreArchivo:   () => "datos.json",
    tiposArchivo: [{ description: "JSON", accept: { "application/json": [".json"] } }]
  }, cfg || {});

  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const CLAVE = C.clave;
  let fileHandle = null, handlePendiente = null;
  let sucio = false, almacenOK = true, idbOK = true;
  let tLocal = null, tArchivo = null;
  let ultimoGuardadoTs = null, ultimoDestino = "";

  try { localStorage.setItem("__t", "1"); localStorage.removeItem("__t"); }
  catch (e) { almacenOK = false; }

  /* ── IndexedDB: el manejador del archivo y los respaldos ──────────────
     El navegador no permite guardar una ruta, pero sí conservar el permiso
     sobre el archivo elegido. */
  function idb() {
    return new Promise((res, rej) => {
      try {
        const r = indexedDB.open(CLAVE + "__fs", 1);
        r.onupgradeneeded = () => r.result.createObjectStore("h");
        r.onsuccess = () => res(r.result);
        r.onerror   = () => rej(r.error);
        r.onblocked = () => rej(new Error("bloqueado"));
      } catch (e) { rej(e); }
    });
  }
  function leerClave(db, k) {
    return new Promise((res) => {
      const t = db.transaction("h", "readonly");
      const q = t.objectStore("h").get(k);
      q.onsuccess = () => res(q.result);
      q.onerror   = () => res(undefined);
    });
  }
  function escribirClave(db, k, v) {
    return new Promise((res) => {
      const t = db.transaction("h", "readwrite");
      t.objectStore("h").put(v, k);
      t.oncomplete = res; t.onerror = res;
    });
  }
  async function guardarHandle(h) {
    try { await escribirClave(await idb(), "archivo", h); } catch (e) { idbOK = false; }
  }
  async function leerHandle() {
    try { return (await leerClave(await idb(), "archivo")) || null; }
    catch (e) { idbOK = false; return null; }
  }
  async function olvidarHandle() {
    try { await escribirClave(await idb(), "archivo", null); } catch (e) {}
  }

  /* ── lectura del archivo ──────────────────────────────────────────────
     Lanza si el contenido no es de esta herramienta; devuelve null si el
     archivo está en blanco. Quien la llame debe distinguir los dos casos. */
  async function leerJSONde(h) {
    const f = await h.getFile();
    const t = await f.text();
    if (!t.trim()) return null;
    const d = JSON.parse(t);
    if (!C.validar(d)) throw new Error("el archivo no es de esta herramienta");
    return d;
  }
  async function permisoEscritura(h) {
    try {
      if ((await h.queryPermission({ mode: "readwrite" })) === "granted") return true;
      return (await h.requestPermission({ mode: "readwrite" })) === "granted";
    } catch (e) { return false; }
  }

  /* ── localStorage ─────────────────────────────────────────────────────
     GUARDA 1 aplicada también al navegador:
     si en localStorage había algo y no se pudo leer, la pantalla arranca con
     lo que sea que ponga la app — el ejemplo, en blanco — y el primer
     guardado, o el `beforeunload`, lo escribiría encima. Es el mismo error
     del archivo, un piso más abajo: una lectura fallida no puede terminar en
     escritura. Se conserva el texto crudo para poder rescatarlo. */
  let ilegibleLocal = false, crudoLocal = null;

  function guardarLocal() {
    if (!almacenOK) return false;
    if (ilegibleLocal) return false;        // ← no se escribe sobre lo que no se pudo leer
    try { localStorage.setItem(CLAVE, JSON.stringify(C.estado())); sucio = false; return true; }
    catch (e) { almacenOK = false; return false; }
  }
  function restaurarLocal() {
    let raw = null;
    try { raw = localStorage.getItem(CLAVE); }
    catch (e) { almacenOK = false; return false; }
    if (!raw) return false;                 // no había nada: sí se puede escribir
    try {
      const d = JSON.parse(raw);
      if (!C.validar(d)) throw new Error("el contenido guardado no es de esta herramienta");
      C.cargarEstado(d);
      return true;
    } catch (e) {
      ilegibleLocal = true; crudoLocal = raw;
      return false;                         // había algo y no se pudo leer: queda bloqueado
    }
  }
  /* El bloqueo lo levanta el usuario, nunca la app sola: primero que rescate
     el contenido, después decide descartarlo. */
  function liberarLocal() { ilegibleLocal = false; crudoLocal = null; return guardarLocal(); }

  /* ── respaldo rotativo ────────────────────────────────────────────────
     Las últimas versiones previas a una escritura, en IndexedDB. Es el
     «deshacer» que casi ninguna app de archivo único tiene. Nunca propaga
     excepciones: un fallo al respaldar no puede impedir guardar. */
  async function respaldar() {
    if (C.estadoVacio()) return;
    try {
      const db = await idb();
      const lista = (await leerClave(db, "respaldos")) || [];
      const S = C.estado();
      const txt = JSON.stringify(S);
      /* Si tu estado lleva una marca de hora, exclúyela en `clave` para que
         guardar dos veces lo mismo no gaste una ranura. */
      const clave = C.clavePorContenido ? C.clavePorContenido(S) : txt;
      if (lista[0] && lista[0].clave === clave) return;
      lista.unshift({ ts: Date.now(), resumen: C.resumen(S), clave, txt });
      while (lista.length > C.maxRespaldos) lista.pop();
      await escribirClave(db, "respaldos", lista);
    } catch (e) { /* el respaldo nunca debe impedir guardar */ }
  }
  async function respaldos() {
    try { return (await leerClave(await idb(), "respaldos")) || []; }
    catch (e) { return []; }
  }

  /* ── GUARDA 2 · nunca escribir vacío sobre contenido ──────────────────
     Es la red de seguridad: aunque toda la lógica de vinculación falle, el
     archivo no se pierde. Se paga una lectura extra solo en el caso raro
     (pantalla vacía), no en el camino normal. */
  async function guardarArchivo() {
    if (!fileHandle) return false;

    if (C.estadoVacio()) {
      let d = null, fallo = false;
      try { d = await leerJSONde(fileHandle); } catch (e) { fallo = true; }

      if (fallo) {
        C.aviso("No se escribió el archivo",
          "No se pudo leer <b>" + esc(fileHandle.name) + "</b> y en pantalla no hay " +
          "contenido, así que no se escribió nada. El archivo quedó intacto.");
        return false;
      }
      if (!C.datosVacios(d)) {
        /* Desvincular, no solo abortar: si el manejador sigue puesto, el
           siguiente cambio vuelve a intentarlo y el aviso se repite sin fin. */
        const nom = fileHandle.name;
        fileHandle = null; olvidarHandle();
        C.aviso("Se protegió tu archivo",
          "<b>" + esc(nom) + "</b> contiene " + esc(C.resumen(d)) + " y esta pantalla " +
          "está vacía. No se escribió nada y se desvinculó el archivo.<br><br>" +
          "Vuelve a abrirlo para seguir trabajando sobre él.");
        C.marcar("Archivo protegido — desvinculado", "warn");
        C.render();
        return false;
      }
    }

    try {
      await respaldar();
      const w = await fileHandle.createWritable();
      await w.write(JSON.stringify(C.estado(), null, 2));
      await w.close();
      sucio = false; ultimoGuardadoTs = Date.now(); ultimoDestino = "archivo";
      C.marcar("Guardado en " + fileHandle.name, "vinc");
      return true;
    } catch (e) { return false; }
  }

  /* Autoguardado con debounce. Llámalo en cada cambio del usuario. */
  function tocar() {
    sucio = true;
    C.marcar("Cambios sin guardar…", "warn");
    clearTimeout(tLocal);
    tLocal = setTimeout(() => {
      const ok = guardarLocal();
      if (fileHandle) {
        clearTimeout(tArchivo);
        tArchivo = setTimeout(async () => {
          if (!await guardarArchivo()) C.marcar("No se pudo escribir el archivo", "warn");
        }, C.debounceArchivo);
      } else {
        ultimoGuardadoTs = Date.now(); ultimoDestino = "navegador";
        C.marcar(ok ? "Guardado en el navegador" : "Sin autoguardado — descarga el JSON",
                 ok ? "ok" : "warn");
      }
    }, C.debounceLocal);
  }

  async function activarHandle(h, escribirYa) {
    fileHandle = h; handlePendiente = null;
    if (escribirYa === false) { C.marcar("Vinculado a " + h.name, "vinc"); C.render(); return true; }
    const ok = await guardarArchivo();
    C.marcar(ok ? ("Guardado en " + h.name) : "No se pudo escribir el archivo", ok ? "vinc" : "warn");
    C.render();
    return ok;
  }

  /* ── GUARDA 1 · una lectura fallida nunca termina en escritura ────────
     `fallo` va aparte de `d` a propósito: no es lo mismo «no se pudo leer»
     que «se leyó y está vacío», y no se decide igual. */
  async function vincular() {
    if (!global.showOpenFilePicker) return { ok: false, motivo: "sin-api" };
    let h;
    try { [h] = await global.showOpenFilePicker({ types: C.tiposArchivo, multiple: false }); }
    catch (e) { return { ok: false, motivo: "cancelado" }; }
    return vincularHandle(h);
  }

  /* Reconectar el archivo recordado. Tras recargar, el navegador pide permiso
     otra vez y eso exige un clic: sin esta función la única salida era volver
     a buscarlo con el selector, y mientras tanto todo se guardaba solo en el
     navegador sin que nadie lo notara. Se llama desde un clic del usuario. */
  async function reconectarPendiente() {
    const h = handlePendiente;
    if (!h) return { ok: false, motivo: "sin-pendiente" };
    if (!await permisoEscritura(h)) {
      C.marcar("Sin permiso para " + h.name, "warn");
      return { ok: false, motivo: "sin-permiso" };
    }
    return vincularHandle(h);
  }

  async function vincularHandle(h) {
    let d = null, fallo = false;
    try { d = await leerJSONde(h); } catch (e) { fallo = true; }

    if (fallo) {
      C.aviso("No se vinculó el archivo",
        "No se pudo leer <b>" + esc(h.name) + "</b>, así que no se vinculó ni se " +
        "escribió nada: su contenido quedó intacto.");
      return { ok: false, motivo: "ilegible" };   // ← salir, no continuar
    }

    /* Si se acaba de cargar el contenido del archivo no hay nada que escribir
       de vuelta: hacerlo solo añadiría una oportunidad de fallar. */
    let escribir = true;
    if (d) {
      let cargar = true;
      const clave = x => C.clavePorContenido ? C.clavePorContenido(x) : JSON.stringify(x);
      if (!C.estadoVacio() && clave(d) === clave(C.estado())) {
        cargar = false; escribir = false;      /* son iguales: no hay nada que preguntar */
      } else if (!C.estadoVacio()) {
        cargar = global.confirm(
          "El archivo contiene " + C.resumen(d) + ".\n\n" +
          "Aceptar: cargar el archivo y reemplazar lo que tienes en pantalla.\n" +
          "Cancelar: conservar lo de pantalla y sobrescribir el archivo con ello.");
      }
      if (cargar) { C.cargarEstado(d); guardarLocal(); escribir = false; }
    }

    if (!await permisoEscritura(h)) {
      C.render();
      C.marcar("Cargado, sin permiso de escritura", "warn");
      return { ok: false, motivo: "sin-permiso" };
    }
    await guardarHandle(h);
    await activarHandle(h, escribir);
    return { ok: true };
  }

  /* Crear un archivo nuevo. Si el elegido ya tenía contenido, se pregunta. */
  async function archivoNuevo() {
    if (!global.showSaveFilePicker) return { ok: false, motivo: "sin-api" };
    try {
      const h = await global.showSaveFilePicker({
        suggestedName: C.nombreArchivo(), types: C.tiposArchivo });
      let d = null;
      try { d = await leerJSONde(h); } catch (e) { d = null; }
      if (d && !C.datosVacios(d) && !global.confirm(
            "Ese archivo ya contiene " + C.resumen(d) + ".\n\n" +
            "Aceptar: sobrescribirlo con lo que tienes en pantalla.\nCancelar: no hacer nada."))
        return { ok: false, motivo: "cancelado" };
      await guardarHandle(h);
      await activarHandle(h);
      return { ok: true };
    } catch (e) { return { ok: false, motivo: "cancelado" }; }
  }

  /* Traer cambios hechos desde otro navegador o equipo. */
  async function recargarDesdeArchivo() {
    if (!fileHandle) return { ok: false, motivo: "sin-archivo" };
    try {
      const d = await leerJSONde(fileHandle);
      if (!d) return { ok: false, motivo: "vacio" };
      if (!global.confirm("Se reemplazará lo que tienes en pantalla por el contenido del " +
                          "archivo (" + C.resumen(d) + "). ¿Continuar?"))
        return { ok: false, motivo: "cancelado" };
      C.cargarEstado(d); guardarLocal(); C.render();
      C.marcar("Recargado desde " + fileHandle.name, "vinc");
      return { ok: true };
    } catch (e) { return { ok: false, motivo: "ilegible" }; }
  }

  function descargar(nombre) {
    const blob = new Blob([JSON.stringify(C.estado(), null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = nombre || C.nombreArchivo();
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
    ultimoGuardadoTs = Date.now(); ultimoDestino = "descarga";
  }

  /* ── GUARDA 3 · una sola pestaña a la vez ─────────────────────────────
     Dos pestañas comparten localStorage y el mismo archivo: la última en
     guardar pisa a la otra y ninguna se entera. Hacen falta dos señales:
     · el LATIDO es fiable, pero Chrome frena los temporizadores de las
       pestañas de fondo, de ahí la caducidad amplia y el refresco al volver;
     · el PING viaja por el evento `storage`, que sí llega a las pestañas de
       fondo, y una pestaña cerrada o colgada simplemente no contesta, así
       que nunca deja un turno trabado. */
  const K_LATIDO = CLAVE + "__pestana", K_PING = CLAVE + "__ping", K_PONG = CLAVE + "__pong";
  const MI_PESTANA = Math.random().toString(36).slice(2) + Date.now().toString(36);
  let vivo = true, hayOtra = false, tLatido = null;

  function latir() {
    if (!vivo) return;
    try { localStorage.setItem(K_LATIDO, JSON.stringify({ id: MI_PESTANA, ts: Date.now() })); }
    catch (e) {}
  }
  function latidoAjeno() {
    try {
      const t = JSON.parse(localStorage.getItem(K_LATIDO) || "null");
      return !!(t && t.id !== MI_PESTANA && (Date.now() - t.ts) < C.caducaPestana);
    } catch (e) { return false; }
  }
  function tomarTurno() {
    latir();
    clearInterval(tLatido); tLatido = setInterval(latir, 2000);
    global.addEventListener("visibilitychange", latir);
    global.addEventListener("focus", latir);
  }
  function soltarPestana() {
    vivo = false; clearInterval(tLatido);
    try {
      const t = JSON.parse(localStorage.getItem(K_LATIDO) || "null");
      if (t && t.id === MI_PESTANA) localStorage.removeItem(K_LATIDO);
    } catch (e) {}
  }
  global.addEventListener("storage", (ev) => {
    if (!ev.newValue) return;
    if (ev.key === K_PING && vivo) {
      try { localStorage.setItem(K_PONG, JSON.stringify({ id: MI_PESTANA, ts: Date.now() })); }
      catch (e) {}
      return;
    }
    if (ev.key === K_PONG) {
      try { if (JSON.parse(ev.newValue).id !== MI_PESTANA) hayOtra = true; } catch (e) {}
    }
  });
  function hayOtraPestana() {
    if (latidoAjeno()) return Promise.resolve(true);
    hayOtra = false;
    try { localStorage.setItem(K_PING, JSON.stringify({ id: MI_PESTANA, ts: Date.now() })); }
    catch (e) {}
    return new Promise((res) => setTimeout(() => res(hayOtra || latidoAjeno()), 600));
  }

  /* ── GUARDA 1 (bis) · reconexión del archivo recordado ────────────────
     El error original vivía aquí: un catch vacío dejaba el archivo vinculado
     con la pantalla en blanco, y el primer autoguardado lo borraba. */
  async function reconectarRecordado() {
    if (!global.showSaveFilePicker) return;
    const h = await leerHandle();
    if (!h) return;
    try {
      if ((await h.queryPermission({ mode: "readwrite" })) !== "granted") {
        handlePendiente = h; return;   // hace falta un clic del usuario
      }
      if (C.estadoVacio()) {
        let d = null, fallo = false;
        try { d = await leerJSONde(h); } catch (e) { fallo = true; }
        if (fallo || !d) {
          handlePendiente = h;
          C.aviso("No se vinculó el archivo",
            "No se pudo leer <b>" + esc(h.name) + "</b> y esta pantalla está vacía. " +
            "No se vinculó, para que ningún guardado automático lo sobrescriba.<br><br>" +
            "Ábrelo a mano para seguir trabajando sobre él.");
          C.marcar("No se pudo leer el archivo recordado", "warn");
          C.render();
          return;
        }
        C.cargarEstado(d); guardarLocal();
      }
      fileHandle = h;
      C.marcar("Archivo vinculado: " + h.name, "vinc");
      C.render();
    } catch (e) { handlePendiente = h; }
  }

  /* ── arranque ─────────────────────────────────────────────────────────
     `tomarTurno()` va DESPUÉS de comprobar, nunca antes: una pestaña que
     escribe su latido antes de mirar se lee a sí misma y no detecta a nadie.
     El bloqueo siempre debe ofrecer salida: un falso positivo no puede dejar
     al usuario fuera de su herramienta. */
  async function iniciar(op) {
    op = op || {};
    if (await hayOtraPestana() && typeof op.alBloquear === "function") {
      op.alBloquear();   // tu capa de bloqueo, con «reintentar» y «abrir de todos modos»
      return false;
    }
    return entrar(op);
  }
  async function entrar(op) {
    tomarTurno();
    const habia = restaurarLocal();
    if (op.alArrancar) op.alArrancar(habia);
    C.render();
    await reconectarRecordado();
    return true;
  }

  global.addEventListener("beforeunload", (ev) => {
    guardarLocal(); soltarPestana();
    /* La condición correcta es solo `sucio`: el autoguardado al archivo tarda
       ~1 s desde el último cambio y cerrar dentro de esa ventana pierde
       trabajo aunque haya archivo vinculado. */
    if (sucio) { ev.preventDefault(); ev.returnValue = ""; }
  });
  global.addEventListener("pagehide", soltarPestana);

  return {
    /* estado */
    archivo:        () => fileHandle,
    pendiente:      () => handlePendiente,
    sucio:          () => sucio,
    almacenDisponible: () => almacenOK,
    ultimoGuardado: () => ({ ts: ultimoGuardadoTs, destino: ultimoDestino }),
    /* guardado */
    tocar, guardarLocal, restaurarLocal, guardarArchivo, descargar,
    /* archivo */
    vincular, archivoNuevo, recargarDesdeArchivo, reconectarRecordado, reconectarPendiente,
    desvincular: async () => { fileHandle = null; await olvidarHandle(); C.render(); },
    /* respaldos */
    respaldos, respaldar,
    /* pestañas y arranque */
    iniciar, entrar, hayOtraPestana, soltarPestana,
    /* lectura fallida del navegador */
    localIlegible: () => ilegibleLocal,
    crudoIlegible: () => crudoLocal,
    liberarLocal
  };
}

global.crearPersistencia = crearPersistencia;
if (typeof module === "object" && module.exports) module.exports = { crearPersistencia };

})(typeof window !== "undefined" ? window : globalThis);
