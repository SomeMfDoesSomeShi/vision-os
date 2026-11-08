
import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";

// ==========================================
// CONFIGURATION
// ==========================================

const MAX_DISTANCE = 6;

// Résolution maximale du rendu
// Three.js adapte automatiquement le rendu aux deux yeux.

const $ = id => document.getElementById(id);

const startButton = $("startButton");
const statusElement = $("status");
const messageElement = $("message");

const planeCountElement = $("planeCount");
const nearestDistanceElement = $("nearestDistance");

// ==========================================
// VARIABLES
// ==========================================

let renderer = null;
let scene = null;
let camera = null;
let session = null;
let referenceSpace = null;

let isRunning = false;

const planeVisuals = new Map();

// ==========================================
// SHADER DE PROFONDEUR
// ==========================================

const depthVertexShader = `

    varying vec3 vWorldPosition;

    void main() {

        vec4 worldPosition =
            modelMatrix * vec4(position, 1.0);

        vWorldPosition = worldPosition.xyz;

        gl_Position =
            projectionMatrix *
            viewMatrix *
            worldPosition;

    }

`;

const depthFragmentShader = `

    uniform float uMaxDistance;

    varying vec3 vWorldPosition;

    void main() {

        // Position de la caméra du casque.

        float distanceToSurface = distance(
            cameraPosition,
            vWorldPosition
        );

        // Blanc proche, noir éloigné.

        float brightness = clamp(
            1.0 - distanceToSurface / uMaxDistance,
            0.0,
            1.0
        );

        gl_FragColor = vec4(
            brightness,
            brightness,
            brightness,
            1.0
        );

    }

`;

function createDepthMaterial() {

    return new THREE.ShaderMaterial({

        uniforms: {

            uMaxDistance: {
                value: MAX_DISTANCE
            }

        },

        vertexShader: depthVertexShader,
        fragmentShader: depthFragmentShader,

        side: THREE.DoubleSide,

        transparent: false,

        depthTest: true,
        depthWrite: true,

        toneMapped: false

    });

}

// ==========================================
// SUPPORT WEBXR
// ==========================================

async function checkSupport() {

    if (!navigator.xr) {

        statusElement.textContent = "WebXR indisponible";

        messageElement.textContent =
            "Ouvre ce site dans Meta Quest Browser.";

        return;

    }

    try {

        const supported =
            await navigator.xr.isSessionSupported("immersive-ar");

        if (!supported) {

            throw new Error(
                "Mode immersive-ar indisponible"
            );

        }

        statusElement.textContent = "WebXR détecté";

        messageElement.textContent =
            "Scanner de profondeur prêt.";

        startButton.disabled = false;

    } catch (error) {

        statusElement.textContent = "Non compatible";

        messageElement.textContent = error.message;

    }

}

// ==========================================
// CONSTRUIRE UNE SURFACE
// ==========================================

function createPlaneVisual(plane) {

    const group = new THREE.Group();

    const geometry = createPlaneGeometry(plane.polygon);

    const mesh = new THREE.Mesh(
        geometry,
        createDepthMaterial()
    );

    group.add(mesh);

    group.matrixAutoUpdate = false;

    scene.add(group);

    return {

        group,
        mesh,
        polygonSignature: getPolygonSignature(plane.polygon)

    };

}

// ==========================================
// GÉOMÉTRIE DES SURFACES
// ==========================================

function getPolygonSignature(polygon) {

    return polygon.map(point => {

        return [
            point.x.toFixed(4),
            point.y.toFixed(4),
            point.z.toFixed(4)
        ].join(",");

    }).join(";");

}

function createPlaneGeometry(polygon) {

    const positions = [];

    const points = polygon.map(point => {

        return new THREE.Vector3(
            point.x,
            point.y,
            point.z
        );

    });

    for (const point of points) {

        positions.push(
            point.x,
            point.y,
            point.z
        );

    }

    // Triangulation du polygone.

    const indices = [];

    for (let i = 1; i < points.length - 1; i++) {

        indices.push(0, i, i + 1);

    }

    const geometry = new THREE.BufferGeometry();

    geometry.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(positions, 3)
    );

    geometry.setIndex(indices);

    geometry.computeVertexNormals();

    return geometry;

}

// ==========================================
// MISE À JOUR DES SURFACES
// ==========================================

function updatePlane(plane, frame, viewerPosition) {

    if (
        !plane.polygon ||
        plane.polygon.length < 3
    ) {

        return null;

    }

    const pose = frame.getPose(
        plane.planeSpace,
        referenceSpace
    );

    if (!pose) {

        return null;

    }

    let visual = planeVisuals.get(plane);

    if (!visual) {

        visual = createPlaneVisual(plane);

        planeVisuals.set(plane, visual);

    }

    // Actualiser la géométrie si le scan évolue.

    const signature = getPolygonSignature(plane.polygon);

    if (signature !== visual.polygonSignature) {

        visual.mesh.geometry.dispose();

        visual.mesh.geometry =
            createPlaneGeometry(plane.polygon);

        visual.polygonSignature = signature;

    }

    // Transformation spatiale réelle.

    const matrix = new THREE.Matrix4().fromArray(
        pose.transform.matrix
    );

    visual.group.matrix.copy(matrix);

    visual.group.matrixWorldNeedsUpdate = true;

    visual.group.visible = true;

    // Calcul de la distance au centre du plan.

    const center = new THREE.Vector3();

    for (const point of plane.polygon) {

        center.add(
            new THREE.Vector3(
                point.x,
                point.y,
                point.z
            )
        );

    }

    center.multiplyScalar(
        1 / plane.polygon.length
    );

    center.applyMatrix4(matrix);

    return viewerPosition.distanceTo(center);

}

// ==========================================
// NETTOYAGE DES SURFACES
// ==========================================

function removePlane(plane) {

    const visual = planeVisuals.get(plane);

    if (!visual) return;

    scene.remove(visual.group);

    visual.mesh.geometry.dispose();

    visual.mesh.material.dispose();

    planeVisuals.delete(plane);

}

// ==========================================
// ENTRER EN RÉALITÉ MIXTE
// ==========================================

async function enterAR() {

    startButton.disabled = true;

    messageElement.textContent =
        "Initialisation du rendu de profondeur...";

    try {

        session = await navigator.xr.requestSession(
            "immersive-ar",
            {

                requiredFeatures: [
                    "local-floor",
                    "plane-detection"
                ],

                optionalFeatures: [
                    "hand-tracking"
                ]

            }
        );

        // ==================================
        // RENDERER
        // ==================================

        renderer = new THREE.WebGLRenderer({

            alpha: true,
            antialias: true,

            powerPreference: "high-performance"

        });

        renderer.setPixelRatio(
            Math.min(window.devicePixelRatio, 1.5)
        );

        renderer.setSize(
            window.innerWidth,
            window.innerHeight
        );

        renderer.xr.enabled = true;

        renderer.xr.setReferenceSpaceType(
            "local-floor"
        );

        // CORRECTION PRINCIPALE :
        // Fond NOIR OPAQUE.
        // L'ancien code utilisait alpha = 0,
        // ce qui laissait voir la pièce réelle.

        renderer.setClearColor(
            new THREE.Color(0x000000),
            1
        );

        renderer.setClearAlpha(1);

        renderer.domElement.style.position = "fixed";
        renderer.domElement.style.top = "0";
        renderer.domElement.style.left = "0";
        renderer.domElement.style.width = "100vw";
        renderer.domElement.style.height = "100vh";
        renderer.domElement.style.zIndex = "9999";

        document.body.appendChild(
            renderer.domElement
        );

        // ==================================
        // SCENE
        // ==================================

        scene = new THREE.Scene();

        // Le fond de la scène est également noir.

        scene.background = new THREE.Color(0x000000);

        camera = new THREE.PerspectiveCamera(
            70,
            window.innerWidth / window.innerHeight,
            0.01,
            100
        );

        // ==================================
        // WEBXR SESSION
        // ==================================

        await renderer.xr.setSession(session);

        referenceSpace =
            renderer.xr.getReferenceSpace();

        if (!referenceSpace) {

            throw new Error(
                "Espace de référence indisponible."
            );

        }

        document.body.classList.add("xr-active");

        isRunning = true;

        statusElement.textContent = "Scanner actif";

        messageElement.textContent =
            "Carte de profondeur en cours de calcul.";

        session.addEventListener(
            "end",
            stopAR
        );

        renderer.setAnimationLoop(renderFrame);

    } catch (error) {

        console.error(error);

        messageElement.textContent =
            "Erreur : " + error.message;

        if (session) {

            try {
                await session.end();
            } catch (_) {}

        }

        if (renderer) {

            renderer.dispose();

            renderer.domElement.remove();

            renderer = null;

        }

        startButton.disabled = false;

    }

}

// ==========================================
// ARRÊTER LE SCANNER
// ==========================================

function stopAR() {

    isRunning = false;

    if (renderer) {

        renderer.setAnimationLoop(null);

        renderer.dispose();

        renderer.domElement.remove();

        renderer = null;

    }

    for (const plane of planeVisuals.keys()) {

        removePlane(plane);

    }

    if (scene) {

        scene.clear();

    }

    planeVisuals.clear();

    session = null;
    referenceSpace = null;
    scene = null;
    camera = null;

    document.body.classList.remove("xr-active");

    startButton.disabled = false;

    statusElement.textContent = "Scanner arrêté";

    messageElement.textContent =
        "Tu peux relancer le scanner.";

    planeCountElement.textContent = "0";

    nearestDistanceElement.textContent = "—";

}

// ==========================================
// RENDU PAR IMAGE
// ==========================================

function renderFrame(time, frame) {

    if (
        !isRunning ||
        !frame ||
        !referenceSpace
    ) {

        return;

    }

    const viewerPose = frame.getViewerPose(
        referenceSpace
    );

    if (!viewerPose) return;

    const viewerPosition = new THREE.Vector3(

        viewerPose.transform.position.x,
        viewerPose.transform.position.y,
        viewerPose.transform.position.z

    );

    // Surfaces actuellement détectées.

    const planes = frame.detectedPlanes
        ? Array.from(frame.detectedPlanes)
        : [];

    let nearestDistance = Infinity;

    for (const plane of planes) {

        const distance = updatePlane(
            plane,
            frame,
            viewerPosition
        );

        if (
            Number.isFinite(distance) &&
            distance < nearestDistance
        ) {

            nearestDistance = distance;

        }

    }

    // Retirer les anciennes surfaces.

    for (const plane of planeVisuals.keys()) {

        if (!planes.includes(plane)) {

            removePlane(plane);

        }

    }

    // Tableau de bord.

    planeCountElement.textContent =
        planes.length;

    nearestDistanceElement.textContent =
        Number.isFinite(nearestDistance)
            ? nearestDistance.toFixed(2)
            : "—";

    // Rendu stéréoscopique automatique.
    // Three.js utilise les deux caméras du Quest.

    renderer.render(
        scene,
        camera
    );

}

// ==========================================
// EVENEMENTS
// ==========================================

startButton.addEventListener(
    "click",
    enterAR
);

window.addEventListener("resize", () => {

    if (!renderer || !camera) return;

    camera.aspect =
        window.innerWidth / window.innerHeight;

    camera.updateProjectionMatrix();

    renderer.setSize(
        window.innerWidth,
        window.innerHeight
    );

});

checkSupport();
