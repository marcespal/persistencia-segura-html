# Persistencia segura en aplicaciones HTML de un solo archivo

Post-mortem y patrón reutilizable para herramientas web autocontenidas que guardan
el trabajo del usuario en `localStorage` y, opcionalmente, en un archivo local
mediante la **File System Access API** (`showOpenFilePicker` / `createWritable`).

El incidente que originó este documento terminó en la **pérdida total del
contenido de un archivo de trabajo**: 183 KB de datos reemplazados por 32 KB de
estado inicial. Se recuperó desde una copia externa. Las tres guardas que
siguen habrían evitado la pérdida por separado — cualquiera de ellas.

---

## 0 · Qué hay en este repositorio

| Archivo | Para qué |
|---|---|
| `README.md` | El post-mortem y el patrón: las tres guardas, las dos medidas complementarias y el checklist de revisión |
| `persistencia-segura.js` | Implementación de referencia, sin dependencias. Se copia dentro del `<script>` de tu herramienta o se carga con `<script src>` |
| `demo.html` | Una lista de notas con las guardas puestas, para probarlas a mano |
| `pruebas.html` | Los casos del apartado 7 ejecutados contra un `FileSystemFileHandle` simulado |

`demo.html` y `pruebas.html` necesitan un origen propio: sírvelos por HTTP
—`python -m http.server` basta— en vez de abrirlos desde `file://`.

---

## 1 · El patrón de riesgo

Una app de un solo archivo HTML típicamente combina:

| Pieza | Para qué |
|---|---|
| `localStorage` | Autoguardado inmediato, sobrevive al cierre del navegador |
| `FileSystemFileHandle` en IndexedDB | Recordar el archivo vinculado entre sesiones |
| Autoguardado con *debounce* | Escribir sin que el usuario piense en guardar |

La combinación es cómoda y peligrosa: **el estado en memoria es la única fuente
de verdad al momento de escribir**, y ese estado puede estar vacío por razones
que no tienen nada que ver con el usuario.

### Por qué el estado arranca vacío

`localStorage` está particionado por origen. En una app servida desde `file://`
—el caso habitual de una herramienta que se distribuye como un `.html` suelto—
el origen cambia si el archivo cambia de ruta:

- el usuario mueve o copia el archivo,
- una carpeta sincronizada (OneDrive, Drive, Dropbox) lo reubica,
- se abre desde otro navegador o perfil,
- el usuario limpia datos de navegación.

En cualquiera de esos casos la app arranca **con el estado inicial de fábrica**,
sin que nada falle visiblemente. Si además reconecta el archivo vinculado, el
primer autoguardado lo sobrescribe.

---

## 2 · Evidencia forense: cómo distinguir corrupción de sobrescritura

Antes de diagnosticar, conviene confirmar qué clase de daño hubo. Un archivo
*corrupto* conserva rastros del original; un archivo *sobrescrito con estado
inicial* no conserva ninguno.

Señales de que se escribió un estado nuevo, no una versión dañada del anterior:

```
ids de las entidades   → todos distintos a los del respaldo (regenerados)
entidades creadas por  → ausentes
el usuario
banderas y catálogos   → en su valor por defecto, no el editado
colecciones opcionales → longitud 0, no longitud parcial
```

Si **ningún id coincide**, no hubo corrupción: hubo un `nuevoEstado()` escrito
encima. Eso descarta el disco, el JSON y el parser, y apunta directamente al
flujo de guardado.

---

## 3 · Las tres rutas de código que lo permitían

### 3.1 · Lectura fallida que cae en escritura

El patrón defectuoso, en la reconexión del archivo recordado:

```js
let d = null;
try { d = await leerJSONde(h); } catch(e) { d = null; }

if (d && !estadoVacio())      { /* preguntar al usuario */ }
else if (d && estadoVacio())  { cargarEstado(d); }

await activarHandle(h);   // ← escribe el archivo, SIEMPRE
```

Cuando la lectura falla, `d` queda en `null`, **ambas ramas se saltan** y el
flujo llega igual a la escritura. Un error de lectura se convierte en una
escritura destructiva.

> **Regla:** en un flujo leer→decidir→escribir, la ruta de error de la lectura
> debe **salir**, nunca continuar al paso de escritura. Si el `catch` solo
> asigna `null` y el `if` posterior no cubre ese caso, hay un camino silencioso
> hacia la escritura.

### 3.2 · El `catch` vacío en el arranque

```js
if (estadoVacio()) {
  try { const d = await leerJSONde(h); if (d) cargarEstado(d); } catch(e) {}
}
fileHandle = h;   // queda vinculado pase lo que pase
```

El `catch(e){}` se traga el error, el archivo queda vinculado y el estado sigue
vacío. El primer cambio del usuario dispara el autoguardado y lo borra.

### 3.3 · El autoguardado sin condición de contenido

```js
async function guardarArchivo(){
  if (!fileHandle) return false;
  const w = await fileHandle.createWritable();
  await w.write(JSON.stringify(S, null, 2));   // S puede ser el estado inicial
  await w.close();
}
```

Ninguna de las dos primeras rutas habría causado daño si esta función se hubiera
negado a escribir vacío sobre contenido.

---

## 4 · Las tres guardas

### Guarda 1 — una lectura fallida nunca termina en escritura

```js
let d = null, fallo = false;
try { d = await leerJSONde(h); } catch(e) { fallo = true; }

if (fallo || !d) {
  avisoProteccion("No se vinculó el archivo",
    "No se pudo leer <b>" + esc(h.name) + "</b>, así que no se vinculó ni se " +
    "escribió nada: su contenido quedó intacto.");
  return;                        // ← salir, no continuar
}

let escribir = true;
if (!estadoVacio()) {
  if (confirm(/* cargar el archivo o conservar la pantalla */)) {
    cargarEstado(d); escribir = false;
  }
} else { cargarEstado(d); escribir = false; }

await activarHandle(h, escribir);   // escribir solo si NO se acaba de cargar
```

Dos detalles que importan:

- `fallo` es una bandera aparte de `d`. Distinguir «no se pudo leer» de «se leyó
  y está vacío» permite dar mensajes distintos y decidir distinto.
- Si se acaba de cargar el contenido del archivo, **no hay nada que escribir de
  vuelta**. Escribir ahí solo añade una oportunidad de fallar.
- Si el archivo coincide con la pantalla (según `clavePorContenido`), no hay nada
  que preguntar: se vincula sin `confirm()` y sin escribir.

**La misma guarda, un piso más abajo: `localStorage`.** Si en el navegador había
algo guardado y no se pudo leer (JSON roto, o de otra herramienta), la pantalla
arranca con lo que ponga la app — en blanco o un ejemplo — y el primer
autoguardado, o el `beforeunload`, lo escribe encima. Es el mismo error del
archivo: una lectura fallida que termina en escritura.

```js
function restaurarLocal() {
  let raw = null;
  try { raw = localStorage.getItem(CLAVE); } catch (e) { return false; }
  if (!raw) return false;                  // no había nada: sí se puede escribir
  try { const d = JSON.parse(raw); if (!validar(d)) throw 0; cargarEstado(d); return true; }
  catch (e) { ilegibleLocal = true; crudoLocal = raw; return false; }   // ← bloqueado
}
function guardarLocal() {
  if (ilegibleLocal) return false;         // no se escribe sobre lo que no se pudo leer
  /* … */
}
```

El autoguardado queda en pausa hasta que el usuario decide: `P.crudoIlegible()`
le permite descargar el contenido tal cual, y recién después `P.liberarLocal()`
lo descarta y reanuda. La app nunca levanta el bloqueo sola.

**Reconectar el archivo recordado sin volver a buscarlo.** Tras recargar la
página, el navegador vuelve a pedir permiso de escritura y eso exige un clic: el
manejador queda en `P.pendiente()`. Si la interfaz no lo muestra, todo se guarda
solo en el navegador y el usuario cree que sigue escribiendo en su archivo.
`P.reconectarPendiente()`, llamado desde un clic, pide el permiso y vincula por
el mismo camino que `P.vincular()`, con la guarda 1 puesta. Conviene que el
botón de guardar diga *Reconectar* mientras haya uno pendiente.

### Guarda 2 — nunca escribir vacío sobre contenido

Es la red de seguridad: aunque toda la lógica anterior falle, el archivo no se
pierde. Se paga una lectura extra solo en el caso raro (estado vacío), no en el
camino normal.

```js
const vacioDe = d => !(d && ((d.coleccionA||[]).length || (d.coleccionB||[]).length ||
                             (d.coleccionC||[]).length || (d.coleccionD||[]).length));

async function guardarArchivo(){
  if (!fileHandle) return false;

  if (estadoVacio()) {
    let d = null, fallo = false;
    try { d = await leerJSONde(fileHandle); } catch(e) { fallo = true; }

    if (fallo) {
      avisoProteccion("No se escribió el archivo",
        "No se pudo leer el archivo y en pantalla no hay contenido, " +
        "así que no se escribió nada.");
      return false;
    }
    if (!vacioDe(d)) {
      const nom = fileHandle.name;
      fileHandle = null; olvidarHandle();      // desvincular: el peligro es el vínculo
      avisoProteccion("Se protegió tu archivo",
        "<b>" + esc(nom) + "</b> tiene contenido y esta pantalla está vacía. " +
        "No se escribió nada y se desvinculó el archivo.");
      render();
      return false;
    }
  }

  await respaldar();
  const w = await fileHandle.createWritable();
  await w.write(JSON.stringify(S, null, 2));
  await w.close();
  return true;
}
```

**Desvincular, no solo abortar.** Si se aborta pero el `fileHandle` sigue
puesto, el siguiente cambio vuelve a intentarlo y el usuario recibe el aviso una
y otra vez. Quitar el vínculo corta el ciclo y deja claro qué hacer.

**El aviso no puede ser `alert()`.** Un `alert()` se cierra con Enter sin
leerse. Lo que evita una pérdida de datos merece una capa propia que haya que
cerrar a propósito.

### Guarda 3 — una sola pestaña a la vez

Dos pestañas de la misma app comparten `localStorage` y el mismo archivo: la
última en guardar pisa a la otra y ninguna se entera.

La detección necesita **dos señales**, porque ninguna basta sola:

```js
const K_LATIDO = CLAVE + "__pestana",
      K_PING   = CLAVE + "__ping",
      K_PONG   = CLAVE + "__pong";
const MI_PESTANA = Math.random().toString(36).slice(2) + Date.now().toString(36);
const CADUCA = 90000;
let vivo = true, hayOtra = false, tLatido = null;

/* señal 1 · latido con marca de tiempo */
function latir(){
  if (!vivo) return;
  try { localStorage.setItem(K_LATIDO,
        JSON.stringify({id: MI_PESTANA, ts: Date.now()})); } catch(e) {}
}
function latidoAjeno(){
  try {
    const t = JSON.parse(localStorage.getItem(K_LATIDO) || "null");
    return !!(t && t.id !== MI_PESTANA && (Date.now() - t.ts) < CADUCA);
  } catch(e) { return false; }
}
function tomarTurno(){
  latir();
  clearInterval(tLatido); tLatido = setInterval(latir, 2000);
  window.addEventListener("visibilitychange", latir);   // ← ver nota
  window.addEventListener("focus", latir);
}
function soltarPestana(){
  vivo = false; clearInterval(tLatido);
  try {
    const t = JSON.parse(localStorage.getItem(K_LATIDO) || "null");
    if (t && t.id === MI_PESTANA) localStorage.removeItem(K_LATIDO);
  } catch(e) {}
}

/* señal 2 · ping/pong por el evento storage */
window.addEventListener("storage", ev => {
  if (!ev.newValue) return;
  if (ev.key === K_PING && vivo) {
    try { localStorage.setItem(K_PONG,
          JSON.stringify({id: MI_PESTANA, ts: Date.now()})); } catch(e) {}
    return;
  }
  if (ev.key === K_PONG) {
    try { if (JSON.parse(ev.newValue).id !== MI_PESTANA) hayOtra = true; } catch(e) {}
  }
});

function hayOtraPestana(){
  if (latidoAjeno()) return Promise.resolve(true);
  hayOtra = false;
  try { localStorage.setItem(K_PING,
        JSON.stringify({id: MI_PESTANA, ts: Date.now()})); } catch(e) {}
  return new Promise(res => setTimeout(() => res(hayOtra || latidoAjeno()), 600));
}

/* arranque */
(async () => {
  if (await hayOtraPestana()) mostrarBloqueo();
  else arrancar();            // arrancar() llama a tomarTurno() como primer paso
})();
window.addEventListener("beforeunload", soltarPestana);
window.addEventListener("pagehide",     soltarPestana);
```

**Por qué dos señales.** Chrome frena los temporizadores de las pestañas en
segundo plano a uno por minuto: una pestaña abierta pero no visible parecería
muerta si solo se mirara el latido. De ahí la ventana de caducidad amplia (90 s)
y el refresco en `visibilitychange` y `focus`. El ping/pong es complementario:
va por el evento `storage`, que sí llega a las pestañas de fondo, y una pestaña
cerrada o colgada simplemente no contesta, así que nunca deja un turno trabado.

**El bloqueo siempre ofrece salida.** Un falso positivo —la pestaña marcada ya
no existe— no puede dejar al usuario fuera de su herramienta. El cuadro lleva
«Ya la cerré, reintentar» y «Abrir de todos modos», con confirmación. Es
preferible preguntar de más que perder trabajo.

**Orden importante:** `tomarTurno()` debe ejecutarse *después* de decidir, nunca
antes. Si la pestaña que arranca escribe su latido antes de comprobar, se lee a
sí misma y nunca detecta a la otra.

---

## 5 · Dos medidas complementarias

### 5.1 · Respaldo rotativo antes de cada escritura

El «deshacer» que casi ninguna app de archivo único tiene. Tres versiones en
IndexedDB cuestan poco y convierten una escritura desastrosa en un incidente de
dos clics.

```js
async function respaldar(){
  if (estadoVacio()) return;                    // no respaldar la nada
  try {
    const db = await idb();
    const lista = await leerClave(db, "respaldos") || [];

    /* La marca de hora cambia en cada guardado; se compara el contenido sin
       ella para que guardar dos veces lo mismo no gaste una ranura. */
    const clave = JSON.stringify(Object.assign({}, S,
      { meta: Object.assign({}, S.meta, { guardadoEn: "" }) }));
    if (lista[0] && lista[0].clave === clave) return;

    lista.unshift({ ts: Date.now(), resumen: resumenDe(S), clave,
                    txt: JSON.stringify(S) });
    while (lista.length > 3) lista.pop();
    await escribirClave(db, "respaldos", lista);
  } catch(e) { /* el respaldo nunca debe impedir guardar */ }
}
```

Dos decisiones deliberadas: el respaldo **nunca propaga excepciones** —un fallo
al respaldar no puede bloquear el guardado— y al restaurar conviene **descargar
también el JSON**, para que la recuperación no dependa del mismo almacenamiento
que acaba de fallar.

### 5.2 · Aviso al cerrar con cambios pendientes

```js
window.addEventListener("beforeunload", ev => {
  guardarLocal(); soltarPestana();
  if (sucio) { ev.preventDefault(); ev.returnValue = ""; }
});
```

El error frecuente es condicionar el aviso a que **no** haya archivo vinculado
(«si hay archivo, ya se guarda solo»). El autoguardado con *debounce* tarda
alrededor de un segundo desde el último cambio: cerrar dentro de esa ventana
pierde trabajo aunque haya archivo. La condición correcta es solo `sucio`.

---

## 6 · Checklist para revisar una app de este tipo

**Flujo de escritura**

- [ ] ¿Existe algún camino en el que una lectura fallida llegue al paso de escritura?
- [ ] ¿Hay `catch` vacíos en el arranque o en la reconexión del archivo?
- [ ] ¿La función que escribe comprueba que hay algo que escribir?
- [ ] ¿Se escribe de vuelta contenido que se acaba de leer, sin necesidad?
- [ ] Cuando se aborta una escritura peligrosa, ¿se desvincula el destino o el ciclo se repite?

**Estado y arranque**

- [ ] ¿Qué pasa si `localStorage` viene vacío y hay un archivo recordado?
- [ ] ¿Y si `localStorage` trae algo ilegible? ¿El autoguardado o el `beforeunload` lo pisan?
- [ ] Tras recargar, ¿el usuario ve que su archivo espera permiso, o todo se guarda solo en el navegador sin que lo note?
- [ ] ¿El usuario nota cuando la app arrancó en blanco, o parece normal?
- [ ] ¿Se distingue «no se pudo leer» de «se leyó y está vacío»?

**Concurrencia y cierre**

- [ ] ¿Dos pestañas pueden escribir el mismo destino?
- [ ] ¿La detección de otra pestaña sobrevive al *throttling* de segundo plano?
- [ ] ¿Un falso positivo deja al usuario sin acceso a su herramienta?
- [ ] ¿El aviso de cierre cubre también el caso con destino vinculado?

**Recuperación**

- [ ] ¿Hay versiones anteriores recuperables sin salir de la app?
- [ ] ¿La restauración depende del mismo almacenamiento que pudo fallar?
- [ ] ¿Los avisos críticos son descartables con Enter sin leerse?

---

## 7 · Notas de prueba

Los casos que hay que cubrir, con un `FileSystemFileHandle` simulado:

```js
const handleFalso = (contenido, romper) => ({
  name: "archivo.json",
  async getFile(){ if (romper) throw new Error("fallo de lectura");
                   return new File([contenido], "archivo.json"); },
  async createWritable(){ return { async write(t){ escrito = t; },
                                   async close(){} }; }
});
```

| Caso | Estado en pantalla | Archivo | Resultado esperado |
|---|---|---|---|
| A | vacío | con contenido | no escribe · desvincula · avisa |
| B | vacío | ilegible | no escribe · avisa |
| C | con contenido | cualquiera | escribe · genera respaldo |
| D | con contenido | cualquiera | segunda escritura idéntica no gasta ranura |
| F | — | — (`localStorage` ilegible) | no autoguarda encima · conserva el texto crudo · solo `liberarLocal()` reanuda |
| G | con contenido | idéntico a la pantalla | vincula sin preguntar y sin escribir |
| H | cualquiera | ninguno pendiente | `reconectarPendiente()` sale con `sin-pendiente` |

Están implementados en `pruebas.html`, que los ejecuta contra el módulo de
referencia y muestra el resultado en una tabla.

Para la guarda 3, dos páginas en el **mismo contexto de navegador**. Advertencia
de entorno: en pruebas automatizadas sobre `file://`, la partición de
`localStorage` entre páginas puede no reproducir el comportamiento de un Chrome
de escritorio real, y el resultado sale intermitente. Verificar a mano abriendo
el archivo dos veces; las guardas 1 y 2, que son las que evitan la pérdida, no
dependen de que el almacenamiento se comparta.

---

## 8 · El principio

> **El estado en memoria no es prueba de nada.**
> Antes de escribir sobre el trabajo de alguien, hay que comprobar que lo que se
> va a escribir vale más que lo que se va a reemplazar. Cuando no se puede
> comprobar, no se escribe.

Corolario para el manejo de errores: en un flujo con efecto destructivo, un
`catch` que solo asigna `null` o que está vacío **no está manejando el error**,
está ocultando la única señal de que no se debe continuar.

---

## 9 · El módulo de referencia

`persistencia-segura.js` implementa todo lo anterior sin dependencias y sin
tocar el DOM: los avisos, el repintado y la píldora de estado los pone la
herramienta que lo usa. Se configura con lo único que la librería no puede
saber sola — qué es «tener contenido» en tu aplicación.

```js
const P = crearPersistencia({
  clave:        "mi_app_v1",          // prefijo de localStorage e IndexedDB
  estado:       () => S,              // el estado en memoria
  cargarEstado: d => { S = d; },      // aplicar un estado leído del archivo
  estadoVacio:  () => !S.notas.length,          // ¿la pantalla no tiene trabajo?
  datosVacios:  d => !(d && (d.notas||[]).length), // ¿el objeto leído tampoco?
  validar:      d => !!(d && d.app === "mi-app"),  // ¿este JSON es mío?
  resumen:      d => (d.notas||[]).length + " notas",  // para los avisos
  aviso:        (titulo, html) => miCapaDeAviso(titulo, html),   // NO alert()
  marcar:       (txt, tono) => pintarPildora(txt, tono),
  render:       () => pintar()
});

P.iniciar({ alBloquear: mostrarBloqueo, alArrancar: habia => pintar() });
```

| Método | Qué hace |
|---|---|
| `P.tocar()` | Llámalo en cada cambio del usuario: autoguarda con *debounce* al navegador y, si hay archivo vinculado, a disco |
| `P.vincular()` | Abre el selector y vincula con la **guarda 1** puesta |
| `P.reconectarPendiente()` | Tras recargar, pide permiso para el archivo recordado y lo vincula con la **guarda 1**; llamarlo desde un clic |
| `P.archivoNuevo()` | Crea un archivo y vincula, preguntando si el elegido ya tenía contenido |
| `P.guardarArchivo()` | Escritura con la **guarda 2** y respaldo previo |
| `P.recargarDesdeArchivo()` | Trae los cambios hechos desde otro equipo |
| `P.descargar(nombre)` | Exporta el JSON, sin depender de la File System Access API |
| `P.respaldos()` | Las últimas versiones previas a una escritura |
| `P.iniciar(op)` / `P.entrar(op)` | Arranque con la **guarda 3**; `entrar` es la salida del bloqueo |
| `P.archivo()`, `P.pendiente()`, `P.sucio()`, `P.ultimoGuardado()` | Estado, para pintar la interfaz |
| `P.localIlegible()`, `P.crudoIlegible()`, `P.liberarLocal()` | `localStorage` que no se pudo leer: avisar, ofrecer descargarlo y, a pedido del usuario, reanudar |

El aviso al cerrar con cambios pendientes y la liberación del turno de pestaña
quedan registrados por el propio módulo.

**De dónde salió esto.** El patrón está extraído de una herramienta real de
levantamiento de cargas de trabajo publicada en
[calculadora-carga-dotacion](https://github.com/marcespal/calculadora-carga-dotacion),
que es donde ocurrió el incidente y donde las guardas llevan tiempo en uso.
