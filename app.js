
import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";

// ==========================================
// CONFIGURATION
// ==========================================

const MAX_DISTANCE = 6;
const ROOM_CAPTURE_DELAY = 2800;

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

let isRunning = false;
let roomCaptureTimer = null;
let roomCaptureAttempted = false;

let roomCaptureStatus = "Non déclenché";
let enabledFeatures = [];

let latestPlaneCount = 0;
let latestMeshCount = 0;

const planeVisuals = new Map();
const meshVisuals = new Map();

// ==========================================
// SHADERS DE PROFONDEUR
// ==========================================

const vertexShader = `
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

const fragmentShader = `
    uniform float uMaxDistance;

    varying vec3 vWorldPosition;

    void main() {
        float d = distance(
            cameraPosition,
            vWorldPosition
        );

        float brightness = clamp(
            1.0 - d / uMaxDistance,
            0.0,
            1.0
        );

        gl_FragColor = vec4(
            vec3(brightness),
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
        vertexShader,
        fragmentShader,
        side: THREE.DoubleSide,
        transparent: false,
        depthTest: true,
        depthWrite: true,
        toneMapped: false
    });
}

// ==========================================
// DIAGNOSTIC
// ==========================================

function logCapabilities() {
    console.group("QUEST DISTANCE SCANNER");

    console.log("XR activé :", !!navigator.xr);
    console.log("Fonction Room Capture :", 
        typeof session?.initiateRoomCapture === "function"
    );

    console.log("Fonctionnalités activées :", enabledFeatures);

    console.log("Repère spatial :", 
        enabledFeatures.includes("unbounded")
            ? "unbounded"
            : "local-floor"
    );

    console.log("Mesh Detection demandé :", 
        enabledFeatures.includes("mesh-detection")
    );

    console.groupEnd();
}

// ==========================================
// GÉOMÉTRIE DES PLANS
// ==========================================

function createPlaneGeometry(polygon) {
    const positions = [];

    for (const point of polygon) {
        positions.push(
            point.x,
            point.y,
            point.z
        );
    }

    const indices = [];

    for (let i = 1; i < polygon.length - 1; i++) {
        indices.push(0, i, i + 1);
    }

    const geometry = new THREE.BufferGeometry();

    geometry.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(positions, 3)
    );

    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();

    return geometry;
}

function getPolygonSignature(polygon) {
    return polygon.map(point =>
        `${point.x.toFixed(4)},${point.y.toFixed(4)},${point.z.toFixed(4)}`
    ).join(";");
}

// ==========================================
// CRÉATION D'UN PLAN
// ==========================================

function createPlaneVisual(plane) {
    const group = new THREE.Group();

    const mesh = new THREE.Mesh(
        createPlaneGeometry(plane.polygon),
        createDepthMaterial()
    );

    group.add(mesh);
    group.matrixAutoUpdate = false;

    scene.add(group);

    return {
        group,
        mesh,
        signature: getPolygonSignature(plane.polygon)
    };
}

// ==========================================
// MISE À JOUR D'UN PLAN
// ==========================================

function updatePlane(plane, frame) {
    if (!plane.polygon || plane.polygon.length < 3) {
        return null;
    }

    const pose = frame.getPose(
        plane.planeSpace,
        referenceSpace
    );

    if (!pose) return null;

    let visual = planeVisuals.get(plane);

    if (!visual) {
        visual = createPlaneVisual(plane);
        planeVisuals.set(plane, visual);
    }

    const signature = getPolygonSignature(plane.polygon);

    if (signature !== visual.signature) {
        visual.mesh.geometry.dispose();

        visual.mesh.geometry =
            createPlaneGeometry(plane.polygon);

        visual.signature = signature;
    }

    visual.group.matrix.fromArray(
        pose.transform.matrix
    );

    visual.group.matrixWorldNeedsUpdate = true;
    visual.group.visible = true;

    return getWorldCenter(visual);
}

// ==========================================
// CRÉATION D'UN MAILLAGE 3D
// ==========================================

function createMeshVisual() {
    const group = new THREE.Group();

    const mesh = new THREE.Mesh(
        new THREE.BufferGeometry(),
        createDepthMaterial()
    );

    group.add(mesh);
    group.matrixAutoUpdate = false;

    scene.add(group);

    return {
        group,
        mesh,
        lastChangedTime: null
    };
}

// ==========================================
// GÉOMÉTRIE DU MAILLAGE
// ==========================================

function updateMeshGeometry(visual, xrMesh) {
    const vertices = xrMesh.vertices;
    const indices = xrMesh.indices;

    if (
        !vertices ||
        vertices.length < 9 ||
        !indices ||
        indices.length < 3
    ) {
        return false;
    }

    const changedTime = xrMesh.lastChangedTime;

    // Éviter de reconstruire la géométrie
    // si le système n'a rien modifié.

    if (
        changedTime !== undefined &&
        changedTime === visual.lastChangedTime
    ) {
        return true;
    }

    const geometry = new THREE.BufferGeometry();

    geometry.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(
            Array.from(vertices),
            3
        )
    );

    geometry.setIndex(Array.from(indices));

    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();

    visual.mesh.geometry.dispose();
    visual.mesh.geometry = geometry;

    visual.lastChangedTime = changedTime ?? null;

    return true;
}

// ==========================================
// MISE À JOUR D'UN MAILLAGE
// ==========================================

function updateDetectedMesh(xrMesh, frame) {
    if (!xrMesh.meshSpace) return null;

    const pose = frame.getPose(
        xrMesh.meshSpace,
        referenceSpace
    );

    if (!pose) return null;

    let visual = meshVisuals.get(xrMesh);

    if (!visual) {
        visual = createMeshVisual();
        meshVisuals.set(xrMesh, visual);
    }

    if (!updateMeshGeometry(visual, xrMesh)) {
        return null;
    }

    visual.group.matrix.fromArray(
        pose.transform.matrix
    );

    visual.group.matrixWorldNeedsUpdate = true;
    visual.group.visible = true;

    return getWorldCenter(visual);
}

// ==========================================
// CENTRE D'UN ÉLÉMENT
// ==========================================

function getWorldCenter(visual) {
    const sphere = visual.mesh.geometry.boundingSphere;

    if (!sphere) return null;

    return sphere.center.clone().applyMatrix4(
        visual.group.matrix
    );
}

// ==========================================
// ROOM CAPTURE META
// ==========================================

async function initiateRoomCapture() {
    if (!session || !isRunning) return;

    if (roomCaptureAttempted) return;

    roomCaptureAttempted = true;

    // La documentation Meta recommande
    // d'appeler cette fonction lorsqu'aucun
    // plan n'a été détecté après 2 à 3 secondes.

    if (latestPlaneCount > 0) {
        roomCaptureStatus =
            "Non nécessaire : des plans sont déjà détectés.";

        console.info(roomCaptureStatus);
        return;
    }

    if (typeof session.initiateRoomCapture !== "function") {
        roomCaptureStatus =
            "API initiateRoomCapture indisponible.";

        console.warn(roomCaptureStatus);
        return;
    }

    roomCaptureStatus = "Demande de capture envoyée.";

    console.info(
        "Demande de Room Capture envoyée à Meta Quest."
    );

    try {
        const result = session.initiateRoomCapture();

        if (result && typeof result.then === "function") {
            await result;
        }

        roomCaptureStatus =
            "Demande envoyée : termine la configuration de la pièce si elle apparaît.";

        console.info(roomCaptureStatus);

    } catch (error) {
        roomCaptureStatus =
            "Erreur Room Capture : " + error.message;

        console.error(
            "Erreur initiateRoomCapture :",
            error
        );
    }
}

// ==========================================
// DÉMARRAGE DU SCANNER
// ==========================================

async function enterAR() {
    startButton.disabled = true;

    messageElement.textContent =
        "Initialisation du scanner et des capacités spatiales...";

    roomCaptureAttempted = false;
    roomCaptureStatus = "En attente";
    latestPlaneCount = 0;
    latestMeshCount = 0;

    try {
        session = await navigator.xr.requestSession(
            "immersive-ar",
            {
                requiredFeatures: [
                    "local-floor",
                    "plane-detection"
                ],

                optionalFeatures: [
                    "unbounded",
                    "mesh-detection",
                    "hand-tracking"
                ]
            }
        );

        enabledFeatures = Array.from(
            session.enabledFeatures || []
        );

        // Choisir le repère spatial selon les capacités
        // réellement activées par le navigateur.

        const referenceType =
            enabledFeatures.includes("unbounded")
                ? "unbounded"
                : "local-floor";

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

        renderer.xr.setReferenceSpaceType(referenceType);

        // Fond noir opaque : aucune image réelle de la pièce.

        renderer.setClearColor(0x000000, 1);
        renderer.setClearAlpha(1);

        renderer.domElement.style.position = "fixed";
        renderer.domElement.style.inset = "0";
        renderer.domElement.style.width = "100vw";
        renderer.domElement.style.height = "100vh";
        renderer.domElement.style.zIndex = "9999";

        document.body.appendChild(renderer.domElement);

        scene = new THREE.Scene();
        scene.background = new THREE.Color(0x000000);

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
                "Impossible d'obtenir l'espace spatial."
            );
        }

        document.body.classList.add("xr-active");

        isRunning = true;

        statusElement.textContent = "Scanner actif";

        roomCaptureStatus =
            typeof session.initiateRoomCapture === "function"
                ? "API disponible"
                : "API indisponible";

        logCapabilities();

        // Laisser le temps aux plans d'arriver.
        // Si aucun plan n'est détecté, déclencher Room Capture.

        roomCaptureTimer = setTimeout(
            initiateRoomCapture,
            ROOM_CAPTURE_DELAY
        );

        session.addEventListener("end", stopAR);

        renderer.setAnimationLoop(renderFrame);

        messageElement.textContent =
            "Scanner actif. Attends la détection de la pièce.";

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
// RENDU
// ==========================================

function renderFrame(time, frame) {
    if (!isRunning || !frame || !referenceSpace) {
        return;
    }

    const viewerPose = frame.getViewerPose(referenceSpace);

    if (!viewerPose) return;

    const viewerPosition = new THREE.Vector3(
        viewerPose.transform.position.x,
        viewerPose.transform.position.y,
        viewerPose.transform.position.z
    );

    // Plans détectés.

    const planes = frame.detectedPlanes
        ? Array.from(frame.detectedPlanes)
        : [];

    // Maillages détectés.

    const meshes = frame.detectedMeshes
        ? Array.from(frame.detectedMeshes)
        : [];

    latestPlaneCount = planes.length;
    latestMeshCount = meshes.length;

    let nearestDistance = Infinity;

    // Accumulation des plans.
    // On ne supprime plus ceux qui disparaissent
    // temporairement du tableau détecté.

    for (const plane of planes) {
        const center = updatePlane(plane, frame);

        if (center) {
            nearestDistance = Math.min(
                nearestDistance,
                viewerPosition.distanceTo(center)
            );
        }
    }

    // Accumulation des maillages.

    for (const xrMesh of meshes) {
        const center = updateDetectedMesh(xrMesh, frame);

        if (center) {
            nearestDistance = Math.min(
                nearestDistance,
                viewerPosition.distanceTo(center)
            );
        }
    }

    // Tableau de bord.

    planeCountElement.textContent =
        planeVisuals.size + meshVisuals.size;

    nearestDistanceElement.textContent =
        Number.isFinite(nearestDistance)
            ? nearestDistance.toFixed(2)
            : "—";

    renderer.render(scene, camera);
}

// ==========================================
// ARRÊT ET RAPPORT
// ==========================================

function stopAR() {
    isRunning = false;

    if (roomCaptureTimer !== null) {
        clearTimeout(roomCaptureTimer);
        roomCaptureTimer = null;
    }

    const finalPlaneCount = planeVisuals.size;
    const finalMeshCount = meshVisuals.size;

    const report =
        `Room Capture : ${roomCaptureStatus}\n` +
        `Plans conservés : ${finalPlaneCount}\n` +
        `Maillages conservés : ${finalMeshCount}\n` +
        `Fonctionnalités activées : ${enabledFeatures.join(", ") || "non communiquées"}`;

    console.info("RAPPORT FINAL DU SCAN");
    console.info(report);

    for (const visual of planeVisuals.values()) {
        scene.remove(visual.group);
        visual.mesh.geometry.dispose();
        visual.mesh.material.dispose();
    }

    for (const visual of meshVisuals.values()) {
        scene.remove(visual.group);
        visual.mesh.geometry.dispose();
        visual.mesh.material.dispose();
    }

    planeVisuals.clear();
    meshVisuals.clear();

    if (renderer) {
        renderer.setAnimationLoop(null);
        renderer.dispose();
        renderer.domElement.remove();
        renderer = null;
    }

    if (scene) {
        scene.clear();
    }

    scene = null;
    camera = null;
    session = null;
    referenceSpace = null;

    document.body.classList.remove("xr-active");

    startButton.disabled = false;

    statusElement.textContent = "Scan terminé";

    messageElement.textContent = report;

    planeCountElement.textContent = "0";
    nearestDistanceElement.textContent = "—";
}

// ==========================================
// REDIMENSIONNEMENT
// ==========================================

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

// ==========================================
// INITIALISATION
// ==========================================

startButton.addEventListener("click", enterAR);

checkSupport();

async function checkSupport() {
    if (!navigator.xr) {
        statusElement.textContent = "WebXR indisponible";
        messageElement.textContent =
            "Ouvre le site dans Meta Quest Browser.";
        return;
    }

    try {
        const supported =
            await navigator.xr.isSessionSupported("immersive-ar");

        if (!supported) {
            throw new Error("Mode immersive-ar indisponible.");
        }

        statusElement.textContent = "WebXR détecté";
        messageElement.textContent =
            "Scanner prêt.";

        startButton.disabled = false;

    } catch (error) {
        statusElement.textContent = "Non compatible";
        messageElement.textContent = error.message;
    }
}
