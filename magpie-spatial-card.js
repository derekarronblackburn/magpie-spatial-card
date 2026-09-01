/*
 * Magpie Spatial Card - a Home Assistant Lovelace custom card that renders a
 * MagpieStash vault's 3D spatial map, with live entity state from `hass`.
 *
 * Data direction (see the HA Spatial Plugin design note): the card needs Magpie
 * only for the LAYOUT (rooms, floors, markers), fetched once from
 * GET {magpie_url}/api/spatial/layout with a read-only share token, and needs
 * HA only for STATE, read straight from the `hass` object the dashboard hands
 * every card - so live updates arrive with no polling.
 *
 * Rendering is the exact same shared builder Magpie's own /mapping/3d page
 * uses ({magpie_url}/static/js/magpie-spatial-scene.js); this card is its
 * second host: it supplies THREE, the label/path helpers, and a haStates map
 * derived from hass.states, and owns the camera, controls, and resize.
 *
 * Install (Lovelace resource, module type):
 *   https://<your-magpie-host>/static/js/magpie-spatial-card.js
 * Card config:
 *   type: custom:magpie-spatial-card
 *   magpie_url: https://magpiestash.app
 *   token: <paste from Magpie Settings -> Home Assistant Card>
 *   property_id: <optional - defaults to the first property>
 *   height: 420   # optional, px
 *   view: 3d      # optional - '3d' (orbit) or '2d' (top-down floor plan)
 *
 * In-card UI: a floor selector (same slice rule as Magpie's /mapping/3d page -
 * the chosen floor and everything below stays visible), a legend that toggles
 * layers (labels, containers, doors, items, entities), and clicking an entity
 * sphere fires HA's native `hass-more-info` dialog for that entity.
 */
(function () {
    'use strict';

    var CARD_VERSION = '1.21.0';

    var THREE_VERSION = '0.128.0';
    var THREE_SCRIPTS = [
        'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js',
        'https://cdn.jsdelivr.net/npm/three@' + THREE_VERSION + '/examples/js/controls/OrbitControls.js',
        'https://cdn.jsdelivr.net/npm/three@' + THREE_VERSION + '/examples/js/loaders/SVGLoader.js',
        'https://cdn.jsdelivr.net/npm/three@' + THREE_VERSION + '/examples/js/renderers/CSS2DRenderer.js'
    ];
    var SCALE_FACTOR = 0.05;
    var DEFAULT_CEILING_HEIGHT = 400;

    var depsPromise = null;

    function loadScript(src) {
        return new Promise(function (resolve, reject) {
            var existing = document.head.querySelector('script[src="' + src + '"]');
            if (existing) {
                if (existing.dataset.magpieLoaded === '1') return resolve();
                existing.addEventListener('load', resolve);
                existing.addEventListener('error', reject);
                return;
            }
            var s = document.createElement('script');
            s.src = src;
            s.addEventListener('load', function () { s.dataset.magpieLoaded = '1'; resolve(); });
            s.addEventListener('error', function () { reject(new Error('Failed to load ' + src)); });
            document.head.appendChild(s);
        });
    }

    function loadDeps(magpieUrl) {
        if (depsPromise) return depsPromise;
        depsPromise = THREE_SCRIPTS.reduce(function (p, src) {
            // three's example scripts attach to window.THREE, so load strictly in order
            return p.then(function () { return loadScript(src); });
        }, Promise.resolve()).then(function () {
            return loadScript(magpieUrl.replace(/\/+$/, '') + '/static/js/magpie-spatial-scene.js');
        });
        return depsPromise;
    }

    var CARD_CSS = [
        ':host { --accent: #4a9eff; --gold: #ffd700; --muted-text: #9aa0a6; display: block; }',
        '.magpie-wrap { position: relative; width: 100%; overflow: hidden; border-radius: var(--ha-card-border-radius, 12px); background: #10141a; }',
        '.magpie-canvas, .magpie-labels { position: absolute; inset: 0; }',
        '.magpie-labels { pointer-events: none; overflow: hidden; }',
        '.magpie-status { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: #9aa0a6; font: 13px sans-serif; text-align: center; padding: 16px; }',
        '.label-3d { color: #ffffff; font-family: "Courier New", Courier, monospace; padding: 4px 10px; background: rgba(0, 0, 0, 0.85); border-left: 3px solid var(--accent); font-size: 11px; font-weight: bold; pointer-events: none; white-space: nowrap; }',
        '.magpie-floors { position: absolute; top: 10px; right: 10px; display: flex; flex-direction: column; gap: 4px; z-index: 5; }',
        '.magpie-floors button { font: bold 10px "Courier New", Courier, monospace; color: var(--muted-text); background: rgba(0, 0, 0, 0.65); border: 1px solid #2d3748; border-radius: 4px; padding: 4px 8px; cursor: pointer; text-align: right; letter-spacing: 0.5px; }',
        '.magpie-floors button:hover { border-color: var(--accent); color: #ffffff; }',
        '.magpie-floors button.active { color: var(--gold); border-color: var(--gold); }',
        '.magpie-legend { position: absolute; left: 10px; bottom: 10px; display: flex; flex-wrap: wrap; gap: 4px; z-index: 5; max-width: 75%; }',
        '.magpie-legend button { font: bold 10px "Courier New", Courier, monospace; color: #e8eaed; background: rgba(0, 0, 0, 0.65); border: 1px solid #2d3748; border-radius: 4px; padding: 4px 8px; cursor: pointer; display: flex; align-items: center; gap: 5px; letter-spacing: 0.5px; }',
        '.magpie-legend button:hover { border-color: var(--accent); }',
        '.magpie-legend button .dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }',
        '.magpie-legend button.off { opacity: 0.35; }',
        '.magpie-view { position: absolute; top: 10px; left: 10px; display: flex; gap: 4px; z-index: 5; }',
        '.magpie-view button { font: bold 10px "Courier New", Courier, monospace; color: var(--muted-text); background: rgba(0, 0, 0, 0.65); border: 1px solid #2d3748; border-radius: 4px; padding: 4px 10px; cursor: pointer; letter-spacing: 0.5px; }',
        '.magpie-view button:hover { color: #ffffff; border-color: var(--accent); }',
        '.magpie-view button.active { color: var(--gold); border-color: var(--gold); }'
    ].join('\n');

    // Legend layers: key -> which userData.type values it governs (in _applyVisibility)
    var LAYERS = [
        { key: 'labels', name: 'LABELS', color: '#ffffff' },
        { key: 'containers', name: 'CONTAINERS', color: '#4a9eff' },
        { key: 'doors', name: 'DOORS', color: '#8b4513' },
        { key: 'items', name: 'ITEMS', color: '#f43f5e' },
        { key: 'entities', name: 'ENTITIES', color: '#00ffff' }
    ];

    function meshLayerFor(type) {
        if (type === 'container') return 'containers';
        if (type === 'door') return 'doors';
        if (type === 'item_marker') return 'items';
        if (type === 'ha_entity') return 'entities';
        return null; // rooms, outlines, platform: always visible
    }

    function labelLayerFor(type) {
        if (type === 'container_label') return 'containers';
        if (type === 'marker_label') return 'items';
        if (type === 'ha_entity_label') return 'entities';
        return null; // room/floor/building labels are governed by the labels toggle alone
    }

    function elevationOf(floor) {
        try {
            var t = (typeof floor.transform === 'string') ? JSON.parse(floor.transform) : floor.transform;
            return (t && t.elevation) || 0;
        } catch (e) { return 0; }
    }

    var MagpieSpatialCard = function () {
        var self = Reflect.construct(HTMLElement, [], MagpieSpatialCard);
        self._hass = null;
        self._config = null;
        self._nodes = null;
        self._haStates = {};
        self._three = null;
        self._started = false;
        self._error = null;
        self._layers = { labels: true, containers: true, doors: true, items: true, entities: true };
        self._selectedMaxFloorId = null; // null = show all floors
        self._entityMeshes = [];
        self._viewMode = '3d';
        return self;
    };
    MagpieSpatialCard.prototype = Object.create(HTMLElement.prototype);
    MagpieSpatialCard.prototype.constructor = MagpieSpatialCard;
    Object.setPrototypeOf(MagpieSpatialCard, HTMLElement);

    MagpieSpatialCard.prototype.setConfig = function (config) {
        if (!config || !config.token) {
            throw new Error('magpie-spatial-card: "token" is required (mint one in Magpie Settings -> Home Assistant Card)');
        }
        this._config = {
            magpie_url: (config.magpie_url || 'https://magpiestash.app').replace(/\/+$/, ''),
            token: config.token,
            property_id: config.property_id || null,
            height: Number(config.height) || 420,
            view: config.view === '2d' ? '2d' : '3d'
        };
        this._viewMode = this._config.view;
        this._renderShell();
        this._boot();
    };

    MagpieSpatialCard.prototype.getCardSize = function () {
        return Math.max(3, Math.round((this._config ? this._config.height : 420) / 50));
    };

    Object.defineProperty(MagpieSpatialCard.prototype, 'hass', {
        set: function (hass) {
            this._hass = hass;
            if (!this._nodes || !this._three) return;
            var next = this._deriveStates(hass);
            if (JSON.stringify(next) !== JSON.stringify(this._haStates)) {
                this._haStates = next;
                this._buildScene();
            }
        }
    });

    MagpieSpatialCard.prototype._deriveStates = function (hass) {
        // Only the entities actually placed on the map matter; ignore the rest of
        // hass.states so unrelated state churn never triggers a rebuild.
        var map = {};
        if (!hass || !this._entityIds) return map;
        for (var i = 0; i < this._entityIds.length; i++) {
            var id = this._entityIds[i];
            var st = hass.states[id];
            if (st) map[id] = st.state;
        }
        return map;
    };

    MagpieSpatialCard.prototype._renderShell = function () {
        if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
        var h = this._config.height;
        this.shadowRoot.innerHTML =
            '<style>' + CARD_CSS + '</style>' +
            '<ha-card>' +
            '<div class="magpie-wrap" style="height:' + h + 'px">' +
            '<div class="magpie-canvas"></div>' +
            '<div class="magpie-labels"></div>' +
            '<div class="magpie-floors"></div>' +
            '<div class="magpie-legend"></div>' +
            '<div class="magpie-view"></div>' +
            '<div class="magpie-status">Loading Magpie spatial map...</div>' +
            '</div>' +
            '</ha-card>';
    };

    MagpieSpatialCard.prototype._status = function (msg) {
        var el = this.shadowRoot && this.shadowRoot.querySelector('.magpie-status');
        if (!el) return;
        if (msg) { el.textContent = msg; el.style.display = 'flex'; }
        else { el.style.display = 'none'; }
    };

    MagpieSpatialCard.prototype._boot = function () {
        var self = this;
        if (self._started) return;
        self._started = true;
        loadDeps(self._config.magpie_url)
            .then(function () { return self._fetchLayout(); })
            .then(function () {
                self._computeFloors();
                self._initThree();
                self._haStates = self._deriveStates(self._hass);
                if (self._viewMode === '2d' && !self._selectedMaxFloorId && self._floors.length > 1) {
                    self._selectedMaxFloorId = self._floorIdsDesc[self._floorIdsDesc.length - 1];
                }
                self._buildScene();
                self._renderFloorPanel();
                self._renderLegend();
                self._renderViewToggle();
                self._status(null);
            })
            .catch(function (err) {
                self._started = false;
                self._status('Magpie card error: ' + (err && err.message ? err.message : err));
            });
    };

    MagpieSpatialCard.prototype._fetchLayout = function () {
        var self = this;
        return fetch(self._config.magpie_url + '/api/spatial/layout', {
            headers: { 'Authorization': 'Bearer ' + self._config.token }
        }).then(function (res) {
            if (res.status === 401) throw new Error('token rejected (expired or revoked) - mint a new one in Magpie Settings');
            if (!res.ok) throw new Error('layout fetch failed (HTTP ' + res.status + ')');
            return res.json();
        }).then(function (data) {
            var nodes = data.nodes || [];
            self._nodes = nodes;
            self._entityIds = [];
            nodes.forEach(function (n) {
                if (n.node_type !== 'ha_entity' || !n.geometry) return;
                var geom = n.geometry;
                try { if (typeof geom === 'string') geom = JSON.parse(geom); } catch (e) { geom = null; }
                if (geom && geom.entity_id) self._entityIds.push(geom.entity_id);
            });
            var props = nodes.filter(function (n) { return n.node_type === 'property'; });
            if (!props.length) throw new Error('this vault has no mapped property yet');
            self._activePropertyId = self._config.property_id || props[0].id;
        });
    };

    MagpieSpatialCard.prototype._initThree = function () {
        var THREE = window.THREE;
        var wrap = this.shadowRoot.querySelector('.magpie-wrap');
        var canvasHost = this.shadowRoot.querySelector('.magpie-canvas');
        var labelHost = this.shadowRoot.querySelector('.magpie-labels');
        var w = wrap.clientWidth || 300, h = wrap.clientHeight || this._config.height;

        var scene = new THREE.Scene();
        scene.background = new THREE.Color(0x10141a);
        scene.add(new THREE.AmbientLight(0xffffff, 0.7));
        var sun = new THREE.DirectionalLight(0xffffff, 0.7);
        sun.position.set(50, 100, 50);
        scene.add(sun);

        var renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setPixelRatio(window.devicePixelRatio || 1);
        renderer.setSize(w, h);
        canvasHost.appendChild(renderer.domElement);

        var labelRenderer = new THREE.CSS2DRenderer();
        labelRenderer.setSize(w, h);
        labelHost.appendChild(labelRenderer.domElement);

        this._three = { THREE: THREE, scene: scene, camera: null, renderer: renderer, labelRenderer: labelRenderer, controls: null, lights: [scene.children[0], sun] };
        this._setupCamera(this._viewMode);

        var self = this;

        // Click an entity sphere -> HA's native more-info dialog. A small move
        // threshold distinguishes a click from an orbit drag.
        this._raycaster = new THREE.Raycaster();
        this._pointerNdc = new THREE.Vector2();
        var downPos = null;
        renderer.domElement.addEventListener('pointerdown', function (e) {
            downPos = { x: e.clientX, y: e.clientY };
        });
        renderer.domElement.addEventListener('pointerup', function (e) {
            if (!downPos) return;
            var moved = Math.abs(e.clientX - downPos.x) + Math.abs(e.clientY - downPos.y);
            downPos = null;
            if (moved > 6) return;
            var entityId = self._pickEntity(e);
            if (entityId) {
                self.dispatchEvent(new CustomEvent('hass-more-info', {
                    bubbles: true, composed: true, detail: { entityId: entityId }
                }));
            }
        });
        var lastHover = 0;
        renderer.domElement.addEventListener('pointermove', function (e) {
            var now = Date.now();
            if (now - lastHover < 80) return;
            lastHover = now;
            renderer.domElement.style.cursor = self._pickEntity(e) ? 'pointer' : '';
        });
        this._resizeObserver = new ResizeObserver(function () {
            var nw = wrap.clientWidth, nh = wrap.clientHeight;
            if (!nw || !nh) return;
            var cam = self._three.camera;
            if (cam.isOrthographicCamera) {
                var half = (cam.top - cam.bottom) / 2;
                cam.left = -half * (nw / nh);
                cam.right = half * (nw / nh);
            } else {
                cam.aspect = nw / nh;
            }
            cam.updateProjectionMatrix();
            renderer.setSize(nw, nh);
            labelRenderer.setSize(nw, nh);
        });
        this._resizeObserver.observe(wrap);

        // The loop reads camera/controls off _three every frame so the 2D/3D
        // toggle can swap them live.
        (function animate() {
            self._raf = requestAnimationFrame(animate);
            var tt = self._three;
            tt.controls.update();
            renderer.render(scene, tt.camera);
            labelRenderer.render(scene, tt.camera);
        })();
    };

    // Create (or replace) the camera + controls for the given view mode.
    // 3d: perspective + orbit. 2d: top-down orthographic, pan/zoom only,
    // oriented so 2D-editor "down" is screen-down (camera.up = -Z).
    MagpieSpatialCard.prototype._setupCamera = function (mode) {
        var t = this._three;
        var THREE = t.THREE;
        var el = t.renderer.domElement;
        var w = el.clientWidth || 300, h = el.clientHeight || this._config.height;
        if (t.controls) t.controls.dispose();

        var camera;
        if (mode === '2d') {
            camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 4000);
            camera.up.set(0, 0, -1);
        } else {
            camera = new THREE.PerspectiveCamera(55, w / h, 0.1, 4000);
        }

        var controls = new THREE.OrbitControls(camera, el);
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        if (mode === '2d') {
            controls.enableRotate = false;
            controls.screenSpacePanning = true;
            controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
            controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };
        }
        t.camera = camera;
        t.controls = controls;
    };

    MagpieSpatialCard.prototype._setViewMode = function (mode) {
        if (mode === this._viewMode) return;
        this._viewMode = mode;
        this._setupCamera(mode);
        this._frameCamera();
        // Top-down with every floor stacked is unreadable; if nothing is
        // sliced yet, default 2D to the bottom floor.
        if (mode === '2d' && !this._selectedMaxFloorId && this._floors && this._floors.length > 1) {
            this._selectedMaxFloorId = this._floorIdsDesc[this._floorIdsDesc.length - 1];
            this._renderFloorPanel();
        }
        // Visibility rules are mode-dependent, so always re-apply on a switch.
        this._applyVisibility();
        this._renderViewToggle();
    };

    MagpieSpatialCard.prototype._renderViewToggle = function () {
        var host = this.shadowRoot.querySelector('.magpie-view');
        if (!host) return;
        host.innerHTML = '';
        var self = this;
        ['3d', '2d'].forEach(function (mode) {
            var btn = document.createElement('button');
            btn.textContent = mode.toUpperCase();
            if (mode === self._viewMode) btn.className = 'active';
            btn.addEventListener('click', function () { self._setViewMode(mode); });
            host.appendChild(btn);
        });
    };

    MagpieSpatialCard.prototype._buildScene = function () {
        var t = this._three;
        var THREE = t.THREE;
        var self = this;

        // Clear everything but the lights; the shared builder re-adds all meshes/labels
        for (var i = t.scene.children.length - 1; i >= 0; i--) {
            var child = t.scene.children[i];
            if (t.lights.indexOf(child) === -1) t.scene.remove(child);
        }

        function parsePath(pathData, loader) {
            try {
                var svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="' + pathData + '" /></svg>';
                var parsed = loader.parse(svg);
                var path = parsed.paths[0];
                if (!path) return null;
                return path.toShapes(true)[0];
            } catch (e) { return null; }
        }

        function addLabel(text, position, type, floorId, nodeId) {
            var div = document.createElement('div');
            div.className = 'label-3d';
            if (type === 'room') {
                div.style.background = 'rgba(0, 0, 0, 0.4)'; div.style.borderLeft = 'none'; div.style.color = 'var(--muted-text)'; div.style.fontSize = '9px'; div.style.boxShadow = 'none'; div.style.padding = '2px 6px';
            } else if (type === 'container') {
                div.style.background = 'transparent'; div.style.borderLeft = 'none'; div.style.color = 'var(--accent)'; div.style.fontSize = '8px'; div.style.boxShadow = 'none'; div.style.padding = '0'; div.style.textShadow = '0px 1px 2px rgba(0,0,0,0.8)';
            } else if (type === 'building') {
                div.style.background = 'rgba(255, 215, 0, 0.15)'; div.style.borderLeft = '3px solid var(--gold)'; div.style.color = 'var(--gold)'; div.style.fontSize = '14px'; div.style.padding = '6px 12px';
            } else if (type === 'marker') {
                div.style.background = 'rgba(0, 0, 0, 0.4)'; div.style.borderLeft = '2px solid #00ffff'; div.style.color = '#00ffff'; div.style.fontSize = '9px'; div.style.boxShadow = 'none'; div.style.padding = '2px 6px';
            } else if (type === 'ha_entity') {
                div.style.background = 'rgba(0, 0, 0, 0.6)'; div.style.borderLeft = '2px solid #00ffff'; div.style.color = '#00ffff'; div.style.fontSize = '9px'; div.style.boxShadow = 'none'; div.style.padding = '2px 6px';
            }
            div.textContent = text;
            var label = new THREE.CSS2DObject(div);
            label.position.copy(position);
            label.userData = { type: type + '_label', floorId: floorId, nodeId: nodeId };
            t.scene.add(label);
        }

        window.MagpieSpatialScene.build(t.scene, this._nodes, this._activePropertyId, {
            THREE: THREE,
            addLabel: addLabel,
            parsePath: parsePath,
            SCALE_FACTOR: SCALE_FACTOR,
            DEFAULT_CEILING_HEIGHT: DEFAULT_CEILING_HEIGHT,
            haStates: this._haStates
        });

        // Re-collect the clickable entity meshes and re-apply the floor slice +
        // legend toggles, which a rebuild would otherwise reset.
        this._entityMeshes = [];
        t.scene.traverse(function (obj) {
            if (obj.isMesh && obj.userData && obj.userData.type === 'ha_entity') self._entityMeshes.push(obj);
        });
        this._applyVisibility();

        if (!this._framed) {
            this._frameCamera();
            this._framed = true;
        }
    };

    MagpieSpatialCard.prototype._computeFloors = function () {
        var propId = this._activePropertyId;
        var bldgIds = this._nodes.filter(function (n) { return n.node_type === 'building' && n.parent_id === propId; })
            .map(function (b) { return b.id; });
        var floors = this._nodes.filter(function (n) { return n.node_type === 'floor' && bldgIds.indexOf(n.parent_id) !== -1; });
        // Highest elevation first - same order as /mapping/3d's floor slicer.
        floors.sort(function (a, b) { return elevationOf(b) - elevationOf(a); });
        this._floors = floors;
        this._floorIdsDesc = floors.map(function (f) { return f.id; });
    };

    MagpieSpatialCard.prototype._renderFloorPanel = function () {
        var host = this.shadowRoot.querySelector('.magpie-floors');
        if (!host) return;
        host.innerHTML = '';
        if (!this._floors || this._floors.length <= 1) return;
        var self = this;
        var choices = [{ id: null, name: 'ALL' }].concat(this._floors.map(function (f) {
            return { id: f.id, name: (f.name || 'FLOOR').toUpperCase() };
        }));
        choices.forEach(function (c) {
            var btn = document.createElement('button');
            btn.textContent = c.name;
            if (c.id === self._selectedMaxFloorId) btn.className = 'active';
            btn.addEventListener('click', function () {
                self._selectedMaxFloorId = c.id;
                host.querySelectorAll('button').forEach(function (b) { b.className = ''; });
                btn.className = 'active';
                self._applyVisibility();
            });
            host.appendChild(btn);
        });
    };

    MagpieSpatialCard.prototype._renderLegend = function () {
        var host = this.shadowRoot.querySelector('.magpie-legend');
        if (!host) return;
        host.innerHTML = '';
        var self = this;
        LAYERS.forEach(function (layer) {
            var btn = document.createElement('button');
            btn.className = self._layers[layer.key] ? '' : 'off';
            var dot = document.createElement('span');
            dot.className = 'dot';
            dot.style.background = layer.color;
            btn.appendChild(dot);
            btn.appendChild(document.createTextNode(layer.name));
            btn.addEventListener('click', function () {
                self._layers[layer.key] = !self._layers[layer.key];
                btn.className = self._layers[layer.key] ? '' : 'off';
                self._applyVisibility();
            });
            host.appendChild(btn);
        });
    };

    // One pass computing every object's visibility from the floor slice AND the
    // legend toggles (an object shows only if both allow it). Floor slice rule
    // in 3D matches /mapping/3d: the selected floor and everything below stays
    // visible, floors above are hidden. In 2D (top-down) only the selected
    // floor's objects show; floors below reduce to faint room outlines so the
    // plan stays readable.
    MagpieSpatialCard.prototype._applyVisibility = function () {
        var t = this._three;
        if (!t) return;
        var layers = this._layers;
        var order = this._floorIdsDesc || [];
        var selIdx = this._selectedMaxFloorId ? order.indexOf(this._selectedMaxFloorId) : -1;
        var flat = this._viewMode === '2d';
        t.scene.traverse(function (obj) {
            var ud = obj.userData;
            if (!ud || !ud.type) return;
            var show = true;
            var faint = false;
            if (selIdx !== -1 && ud.floorId) {
                var idx = order.indexOf(ud.floorId);
                if (idx !== -1) {
                    if (idx < selIdx) show = false; // floor is above the selected one
                    else if (flat && idx > selIdx) {
                        // floor is below the selected one, 2D mode
                        if (ud.type === 'room_outline') faint = true;
                        else show = false;
                    }
                }
            }
            if (show) {
                if (ud.type.indexOf('_label') !== -1) {
                    if (!layers.labels) show = false;
                    else {
                        var ll = labelLayerFor(ud.type);
                        if (ll && !layers[ll]) show = false; // label follows its hidden layer
                    }
                } else {
                    var ml = meshLayerFor(ud.type);
                    if (ml && !layers[ml]) show = false;
                }
            }
            obj.visible = show;
            if (ud.type === 'room_outline' && obj.material) {
                obj.material.opacity = faint ? 0.12 : 0.6; // builder default is 0.6
            }
            if (obj.element) obj.element.style.display = show ? '' : 'none'; // CSS2D labels render via DOM
        });
    };

    MagpieSpatialCard.prototype._pickEntity = function (e) {
        var t = this._three;
        if (!t || !this._entityMeshes.length) return null;
        var rect = t.renderer.domElement.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        this._pointerNdc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        this._pointerNdc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        this._raycaster.setFromCamera(this._pointerNdc, t.camera);
        var visibles = this._entityMeshes.filter(function (m) { return m.visible; });
        var hits = this._raycaster.intersectObjects(visibles, false);
        if (hits.length && hits[0].object.userData.entityId) return hits[0].object.userData.entityId;
        return null;
    };

    MagpieSpatialCard.prototype._frameCamera = function () {
        var t = this._three;
        var box = new t.THREE.Box3();
        var any = false;
        // Frame on the actual content (typed meshes), not the oversized platform.
        t.scene.traverse(function (obj) {
            if (obj.isMesh && obj.userData && obj.userData.type) { box.expandByObject(obj); any = true; }
        });
        if (!any) {
            t.scene.traverse(function (obj) {
                if (obj.isMesh) { box.expandByObject(obj); any = true; }
            });
        }
        if (!any) return;
        var center = box.getCenter(new t.THREE.Vector3());
        var size = box.getSize(new t.THREE.Vector3());
        var radius = Math.max(size.x, size.y, size.z, 10);

        if (t.camera.isOrthographicCamera) {
            var el = t.renderer.domElement;
            var aspect = (el.clientWidth || 300) / (el.clientHeight || this._config.height);
            var halfH = Math.max(size.z, size.x / aspect, 10) / 2 * 1.15;
            t.camera.left = -halfH * aspect;
            t.camera.right = halfH * aspect;
            t.camera.top = halfH;
            t.camera.bottom = -halfH;
            t.camera.zoom = 1;
            t.camera.updateProjectionMatrix();
            t.camera.position.set(center.x, center.y + Math.max(radius, 50), center.z);
        } else {
            t.camera.position.set(center.x + radius * 0.9, center.y + radius * 0.9, center.z + radius * 0.9);
        }
        t.controls.target.copy(center);
        t.controls.update();
    };

    MagpieSpatialCard.prototype.disconnectedCallback = function () {
        if (this._raf) cancelAnimationFrame(this._raf);
        if (this._resizeObserver) this._resizeObserver.disconnect();
    };

    if (!customElements.get('magpie-spatial-card')) {
        customElements.define('magpie-spatial-card', MagpieSpatialCard);
    }

    console.info(
        '%c MAGPIE-SPATIAL-CARD %c v' + CARD_VERSION + ' ',
        'background:#10141a;color:#ffd700;font-weight:bold;',
        'background:#4a9eff;color:#10141a;font-weight:bold;'
    );

    window.customCards = window.customCards || [];
    if (!window.customCards.some(function (c) { return c.type === 'magpie-spatial-card'; })) {
        window.customCards.push({
            type: 'magpie-spatial-card',
            name: 'Magpie Spatial Card',
            description: 'Your MagpieStash 3D spatial map with live Home Assistant entity states.'
        });
    }
})();
