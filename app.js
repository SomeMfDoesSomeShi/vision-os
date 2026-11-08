import * as THREE from
    "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";

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

let renderer;
let scene;
let camera;
let session;
let referenceSpace;

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
            throw new Error("Mode immersive-ar non disponible");
        }

        statusElement.textContent = "WebXR détecté";

        startButton.disabled = false;

        messageElement.textContent =
            "Le navigateur accepte les sessions de réalité mixte.";

    } catch (error) {

        statusElement.textContent = "Non compatible";

        messageElement.textContent =
            "La réalité mixte WebXR n'est pas disponible ici.";

    }
}

// ==========================================
// DISTANCE COLORS
// ==========================================

function getDistanceColor(distance) {

    if (distance < 1) {
        return 0xff5555;
    }

    if (distance < 2.5) {
        return 0xffd166;
    }

    return 0x5cf0c0;
}

// ==========================================
// DISTANCE LABEL
// ==========================================

function createLabel() {

    const canvas = document.createElement("canvas");

    canvas.width = 512;
    canvas.height = 128;

    const ctx = canvas.getContext("2d");

    const texture = new THREE.CanvasTexture(canvas);

    const material = new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        depthTest: false
    });

    const sprite = new THREE.Sprite(material);

    sprite.scale.set(0.65, 0.16, 1);

    drawLabel(sprite, "— m");

    return sprite;
}

function drawLabel(sprite, text) {

    const canvas = sprite.material.map.image;

    const ctx = canvas.getContext("2d");

    ctx.clearRect(0, 0, 512, 128);

    ctx.fillStyle = "rgba(5,14,25,.88)";
    ctx.strokeStyle = "#5cf0c0";
    ctx.lineWidth = 5;

    ctx.beginPath();

    ctx.roundRect(
        5,
        5,
        502,
        118,
        24
    );

    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "#ffffff";

    ctx.font = "bold 54px Arial";

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    ctx.fillText(text, 256, 65);

    sprite.material.map.needsUpdate = true;
}

// ==========================================
// CREATE SURFACE
// ==========================================

function createPlaneVisual() {

    const group = new THREE.Group();

    const meshMaterial = new THREE.MeshBasicMaterial({

        color: 0x5cf0c0,

        transparent: true,
        opacity: 0.15,

        side: THREE.DoubleSide,

        depthWrite: false

    });

    const lineMaterial = new THREE.LineBasicMaterial({

        color: 0x5cf0c0,

        transparent: true,
        opacity: 0.95

    });

    const mesh = new THREE.Mesh(
        new THREE.BufferGeometry(),
        meshMaterial
    );

    const line = new THREE.LineLoop(
        new THREE.BufferGeometry(),
        lineMaterial
    );

    const label = createLabel();

    group.add(mesh);
    group.add(line);
    group.add(label);

    scene.add(group);

    return {
        group,
        mesh,
        line,
        label
    };
}

// ==========================================
// UPDATE SURFACE
// ==========================================

function updatePlane(plane, frame, viewerPosition) {

    let visual = planeVisuals.get(plane);

    if (!visual) {

        visual = createPlaneVisual();

        planeVisuals.set(plane, visual);

    }

    const pose = frame.getPose(
        plane.planeSpace,
        referenceSpace
    );

    if (
        !pose ||
        !plane.polygon ||
        plane.polygon.length < 3
    ) {

        visual.group.visible = false;

        return null;
    }

    const matrix = new THREE.Matrix4().fromArray(
        pose.transform.matrix
    );

    const points = plane.polygon.map(point => {

        return new THREE.Vector3(
            point.x,
            point.y,
            point.z
        );

    });

    // Mesh geometry

    const positions = [];

    for (const point of points) {

        positions.push(
            point.x,
            point.y,
            point.z
        );

    }

    // Polygon triangulation

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

    visual.mesh.geometry.dispose();

    visual.mesh.geometry = geometry;

    // Surface outline

    const lineGeometry = new THREE.BufferGeometry()
        .setFromPoints(points);

    visual.line.geometry.dispose();

    visual.line.geometry = lineGeometry;

    // Apply spatial transform

    visual.group.matrixAutoUpdate = false;

    visual.group.matrix.copy(matrix);

    visual.group.matrixWorldNeedsUpdate = true;

    visual.group.visible = true;

    // Calculate world-space center

    const worldPoints = points.map(point => {

        return point.clone().applyMatrix4(matrix);

    });

    const center = worldPoints.reduce(
        (sum, point) => sum.add(point),
        new THREE.Vector3()
    ).multiplyScalar(1 / worldPoints.length);

    // WebXR plane space normal: local Y axis

    const normal = new THREE.Vector3(0, 1, 0)
        .transformDirection(matrix)
        .normalize();

    // Perpendicular distance to the infinite plane

    const distance = Math.abs(
        viewerPosition.clone()
            .sub(center)
            .dot(normal)
    );

    // Update label

    visual.label.position.copy(center);

    visual.label.position.add(
        normal.clone().multiplyScalar(0.03)
    );

    drawLabel(
        visual.label,
        distance.toFixed(2) + " m"
    );

    // Update colors

    const color = getDistanceColor(distance);

    visual.mesh.material.color.setHex(color);

    visual.line.material.color.setHex(color);

    return distance;
}

// ==========================================
// START MIXED REALITY
// ==========================================

async function enterAR() {

    startButton.disabled = true;

    messageElement.textContent =
        "Demande d'accès aux fonctionnalités spatiales...";

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

        renderer.setClearColor(0x000000, 0);

        document.body.appendChild(renderer.domElement);

        scene = new THREE.Scene();

        camera = new THREE.PerspectiveCamera();

        await renderer.xr.setSession(session);

        referenceSpace = renderer.xr.getReferenceSpace();

        if (!referenceSpace) {

            throw new Error("Impossible d'obtenir l'espace de référence.");

        }

        document.body.classList.add("xr-active");

        isRunning = true;

        statusElement.textContent = "Scanner actif";

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

            visual.line.geometry.dispose();

            visual.mesh.material.dispose();

            visual.line.material.dispose();

            visual.label.material.map.dispose();

            visual.label.material.dispose();

        }

        scene.clear();

    }

    planeVisuals.clear();

    session = null;

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

    // Read detected planes

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

    // Remove planes no longer detected

    for (const [plane, visual] of planeVisuals) {

        if (!planes.includes(plane)) {

            scene.remove(visual.group);

            visual.mesh.geometry.dispose();

            visual.line.geometry.dispose();

            visual.label.material.map.dispose();

            visual.mesh.material.dispose();

            visual.line.material.dispose();

            visual.label.material.dispose();

            planeVisuals.delete(plane);

        }

    }

    // Update dashboard

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

    renderer.setSize(
        window.innerWidth,
        window.innerHeight
    );

});

checkSupport();
