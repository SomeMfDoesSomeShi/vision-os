
import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";

// ==========================================
// CONFIGURATION
// ==========================================

// Distance à laquelle les surfaces deviennent complètement noires.
const MAX_DISTANCE_METERS = 6;

// ==========================================
// ELEMENTS
// ==========================================

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

const planeVisuals = new Map();

let isRunning = false;

// ==========================================
// WEBXR SUPPORT
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
            throw new Error("Mode immersive-ar indisponible");
        }

        statusElement.textContent = "WebXR détecté";
        startButton.disabled = false;

        messageElement.textContent =
            "Le scanner est prêt.";

    } catch (error) {

        statusElement.textContent = "Non compatible";

        messageElement.textContent =
            "La réalité mixte WebXR n'est pas disponible.";

    }
}

// ==========================================
// DEPTH SHADER
// ==========================================

// Ce shader est exécuté pour chaque fragment
// (pixel couvert par une surface détectée).

const depthMaterial = () => new THREE.ShaderMaterial({

    uniforms: {
        uMaxDistance: {
            value: MAX_DISTANCE_METERS
        }
    },

    vertexShader: `

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

    `,

    fragmentShader: `

        uniform float uMaxDistance;

        varying vec3 vWorldPosition;

        void main() {

            // Position de la caméra du casque
            // jusqu'au point représenté par ce pixel.

            float distanceToSurface =
                distance(cameraPosition, vWorldPosition);

            // Conversion distance -> luminosité.

            float brightness =
                1.0 - clamp(
                    distanceToSurface / uMaxDistance,
                    0.0,
                    1.0
                );

            // Blanc = proche
            // Noir = éloigné

            gl_FragColor = vec4(
                vec3(brightness),
                1.0
            );

        }

    `,

    side: THREE.DoubleSide,

    transparent: false,
    depthTest: true,
    depthWrite: true,

    toneMapped: false

});

// ==========================================
// CREATE SURFACE
// ==========================================

function createPlaneVisual(plane) {

    const group = new THREE.Group();

    const points = plane.polygon.map(point => {

        return new THREE.Vector3(
            point.x,
            point.y,
            point.z
        );

    });

    const positions = [];

    for (const point of points) {

        positions.push(
            point.x,
            point.y,
            point.z
        );

    }

    // Triangulation simple du polygone.

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

    // Matériau qui calcule la profondeur par pixel.

    const material = depthMaterial();

    const mesh = new THREE.Mesh(
        geometry,
        material
    );

    group.add(mesh);

    group.matrixAutoUpdate = false;

    scene.add(group);

    return {
        group,
        mesh
    };

}

// ==========================================
// UPDATE SURFACE
// ==========================================

function updatePlane(plane, frame, viewerPosition) {

    if (!plane.polygon || plane.polygon.length < 3) {
        return null;
    }

    let visual = planeVisuals.get(plane);

    if (!visual) {

        visual = createPlaneVisual(plane);

        planeVisuals.set(plane, visual);

    }

    const pose = frame.getPose(
        plane.planeSpace,
        referenceSpace
    );

    if (!pose) {

        visual.group.visible = false;
        return null;

    }

    // Position réelle de la surface dans la pièce.

    const matrix = new THREE.Matrix4().fromArray(
        pose.transform.matrix
    );

    visual.group.matrix.copy(matrix);

    visual.group.matrixWorldNeedsUpdate = true;

    visual.group.visible = true;

    // Centre de la surface pour le tableau de bord.

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

    center.multiplyScalar(1 / plane.polygon.length);

    center.applyMatrix4(matrix);

    // Distance du casque au centre de cette surface.

    return viewerPosition.distanceTo(center);

}

// ==========================================
// START MIXED REALITY
// ==========================================

async function enterAR() {

    startButton.disabled = true;

    messageElement.textContent =
        "Initialisation du scanner de profondeur...";

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

        renderer = new THREE.WebGLRenderer({

            alpha: true,
            antialias: true

        });

        renderer.setPixelRatio(
            Math.min(window.devicePixelRatio, 2)
        );

        renderer.setSize(
            window.innerWidth,
            window.innerHeight
        );

        renderer.xr.enabled = true;

        renderer.xr.setReferenceSpaceType("local-floor");

        // Laisse passer l'image réelle du casque
        // dans les zones sans surface détectée.

        renderer.setClearColor(0x000000, 0);

        document.body.appendChild(renderer.domElement);

        scene = new THREE.Scene();

        camera = new THREE.PerspectiveCamera(
            70,
            window.innerWidth / window.innerHeight,
            0.01,
            100
        );

        await renderer.xr.setSession(session);

        referenceSpace = renderer.xr.getReferenceSpace();

        if (!referenceSpace) {

            throw new Error(
                "Impossible d'obtenir l'espace de référence."
            );

        }

        document.body.classList.add("xr-active");

        isRunning = true;

        statusElement.textContent = "Scanner actif";

        messageElement.textContent =
            "Calcul de profondeur en temps réel.";

        session.addEventListener("end", stopAR);

        renderer.setAnimationLoop(renderFrame);

    } catch (error) {

        console.error(error);

        messageElement.textContent =
            "Erreur : " + error.message;

        startButton.disabled = false;

        if (session) {

            try {
                await session.end();
            } catch (_) {}

        }

    }

}

// ==========================================
// STOP MIXED REALITY
// ==========================================

function stopAR() {

    isRunning = false;

    if (renderer) {

        renderer.setAnimationLoop(null);

        renderer.dispose();

        renderer.domElement.remove();

        renderer = null;

    }

    if (scene) {

        for (const visual of planeVisuals.values()) {

            visual.mesh.geometry.dispose();
            visual.mesh.material.dispose();

        }

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
// RENDER LOOP
// ==========================================

function renderFrame(time, frame) {

    if (!isRunning || !frame || !referenceSpace) {
        return;
    }

    const viewerPose = frame.getViewerPose(referenceSpace);

    if (!viewerPose) {
        return;
    }

    const viewerPosition = new THREE.Vector3(

        viewerPose.transform.position.x,
        viewerPose.transform.position.y,
        viewerPose.transform.position.z

    );

    // Récupération des surfaces détectées.

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

    // Supprimer les surfaces qui ne sont plus détectées.

    for (const [plane, visual] of planeVisuals) {

        if (!planes.includes(plane)) {

            scene.remove(visual.group);

            visual.mesh.geometry.dispose();
            visual.mesh.material.dispose();

            planeVisuals.delete(plane);

        }

    }

    // Tableau de bord.

    planeCountElement.textContent = planes.length;

    nearestDistanceElement.textContent =
        Number.isFinite(nearestDistance)
            ? nearestDistance.toFixed(2)
            : "—";

    renderer.render(scene, camera);

}

// ==========================================
// EVENTS
// ==========================================

startButton.addEventListener("click", enterAR);

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
