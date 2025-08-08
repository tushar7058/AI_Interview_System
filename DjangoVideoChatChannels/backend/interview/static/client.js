let localStream, remoteStream, peerConnection;
let username = "";
let isInitiator = false;
let socket, transcriptionSocket, dataChannel;
let remoteUsername = "", lastTranscript = "", interviewStarted = false;

const servers = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");
const transcriptBox = document.getElementById("transcript");
const camBtn = document.getElementById("camBtn");
const micBtn = document.getElementById("micBtn");
const screenBtn = document.getElementById("screenBtn");
const chatBtn = document.getElementById("chatBtn");
const endBtn = document.getElementById("endBtn");
const chatBox = document.getElementById("chatBox");
const messages = document.getElementById("messages");
const chatInput = document.getElementById("chatInput");
const sendBtn = document.getElementById("sendBtn");
const typing = document.getElementById("typing");
const joinBtn = document.getElementById("joinBtn");
const usernameInput = document.getElementById("usernameInput");
const usernamePrompt = document.getElementById("usernamePrompt");

joinBtn.onclick = async () => {
  username = usernameInput.value.trim();
  if (!username) return alert("Please enter a name");
  usernamePrompt.style.display = "none";
  document.getElementById("localName").textContent = username;
  start();
};

async function start() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVideo.srcObject = localStream;
    console.log("🟢 Local media stream started");

    // 🧪 TEMP: Trigger agent manually for testing
    if (!interviewStarted) {
      interviewStarted = true;
      startInterviewAutomatically();
    }

  } catch (err) {
    console.error("❌ Error accessing camera/microphone:", err);
    return;
  }


  // WebSocket connections
  socket = new WebSocket(
    (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws/signaling/"
  );

  transcriptionSocket = new WebSocket(
    `${location.protocol === "https:" ? "wss://" : "ws://"}${location.host}/ws/transcribe/?username=${username}`
  );

  transcriptionSocket.onopen = () => console.log("🟢 Transcription WebSocket connected");
  transcriptionSocket.onerror = (err) => console.error("❌ Transcription WebSocket error", err);
  transcriptionSocket.onclose = () => console.warn("🔴 Transcription WebSocket closed");

  transcriptionSocket.onmessage = handleTranscriptionMessage;
  startTranscription(localStream);

  socket.onopen = () => {
    send({ type: "join", username });
    console.log("🔗 Signaling WebSocket connected");
  };

  socket.onmessage = handleSignalingMessage;
}

function send(msg) {
  socket.send(JSON.stringify({ ...msg, username }));
}

function handleSignalingMessage({ data }) {
  const msg = JSON.parse(data);

  if (msg.type === "join" && msg.username !== username) {
    remoteUsername = msg.username;
    isInitiator = true;
    createPeerConnection();
    addLocalTracks();
    dataChannel = peerConnection.createDataChannel("chat");
    setupDataChannel();
    peerConnection.createOffer().then((offer) => {
      peerConnection.setLocalDescription(offer);
      send({ type: "offer", offer, to: remoteUsername });
    });
  }

  if (msg.type === "offer" && msg.to === username) {
    remoteUsername = msg.username;
    createPeerConnection();
    addLocalTracks();
    peerConnection.ondatachannel = (e) => {
      dataChannel = e.channel;
      setupDataChannel();
    };
    peerConnection.setRemoteDescription(new RTCSessionDescription(msg.offer)).then(() =>
      peerConnection.createAnswer().then((answer) => {
        peerConnection.setLocalDescription(answer);
        send({ type: "answer", answer, to: remoteUsername });
      })
    );
  }

  if (msg.type === "answer" && msg.to === username) {
    peerConnection.setRemoteDescription(new RTCSessionDescription(msg.answer));
  }

  if (msg.type === "candidate" && msg.to === username) {
    const candidate = new RTCIceCandidate(msg.candidate);
    peerConnection.addIceCandidate(candidate).catch(console.error);
  }
}

function createPeerConnection() {
  peerConnection = new RTCPeerConnection(servers);
  peerConnection.onicecandidate = ({ candidate }) => {
    if (candidate) send({ type: "candidate", candidate, to: remoteUsername });
  };
  peerConnection.ontrack = ({ streams: [stream] }) => {
    remoteVideo.srcObject = stream;
    document.getElementById("remoteName").textContent = remoteUsername;
    // ✅ Automatically start agent when remote stream is received
    if (!interviewStarted) {
      interviewStarted = true;
      startInterviewAutomatically();
    }
  };
}

function addLocalTracks() {
  localStream.getTracks().forEach((track) => peerConnection.addTrack(track, localStream));
}

function setupDataChannel() {
  dataChannel.onmessage = (e) => {
    const data = JSON.parse(e.data);
    if (data.type === "chat") {
      messages.innerHTML += `<div><b>${remoteUsername}:</b> ${data.message}</div>`;
    } else if (data.type === "typing") {
      typing.textContent = `${remoteUsername} is typing...`;
      setTimeout(() => (typing.textContent = ""), 1000);
    }
  };
}

// ✅ Agent Start Trigger
async function startInterviewAutomatically() {
  try {
    const response = await fetch("/agent/start/", { method: "POST" });
    const data = await response.json();
    console.log("🎤 Agent started:", data.question);
    displayAgentMessage(data.question);
  } catch (err) {
    console.error("❌ Failed to start interview:", err);
  }
}

function handleTranscriptionMessage(event) {
  const data = JSON.parse(event.data);
  if (data.type !== "transcript") return;

  const who = data.sender === username ? username : remoteUsername || data.sender;
  transcriptBox.innerHTML += `<div><b>${who}:</b> ${data.text}</div>`;
  transcriptBox.scrollTop = transcriptBox.scrollHeight;

  if (data.sender === username && data.text !== lastTranscript) {
    lastTranscript = data.text;
    fetchAgentResponse(data.text).then((response) => {
      if (response) displayAgentMessage(response);
    });
  }
}

// 📤 Transcript streaming
function startTranscription() {
  const audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(localStream);
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  source.connect(processor);
  processor.connect(audioContext.destination);

  processor.onaudioprocess = (e) => {
    if (transcriptionSocket.readyState === WebSocket.OPEN) {
      const input = e.inputBuffer.getChannelData(0);
      const buffer = convertFloat32ToInt16(input);
      transcriptionSocket.send(buffer);
    }
  };
}

function convertFloat32ToInt16(buffer) {
  const buf = new Int16Array(buffer.length);
  for (let i = 0; i < buffer.length; i++) {
    buf[i] = Math.min(1, buffer[i]) * 0x7fff;
  }
  return buf.buffer;
}

// 🤖 Ask agent for next question
async function fetchAgentResponse(text) {
  try {
    const res = await fetch("/agent/send_answer/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript: text }),
    });

    // Check if the response was successful
    if (!res.ok) {
      const errorText = await res.text(); // Read the response as text
      console.error(`⚠️ Server responded with status ${res.status}: ${errorText}`);
      return null; // Or throw an error
    }

    const data = await res.json();
    return data.question;
  } catch (err) {
    console.error("⚠️ Failed to fetch agent question:", err);
    return null;
  }
}

// 💬 Show and speak agent message
function displayAgentMessage(msg) {
  transcriptBox.innerHTML += `<div><b>Agent:</b> ${msg}</div>`;
  transcriptBox.scrollTop = transcriptBox.scrollHeight;
  speak(msg);
}

function speak(text) {
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "en-US";
  utterance.rate = 1.0;
  speechSynthesis.speak(utterance);
}

// 📩 Chat & Control Buttons
sendBtn.onclick = () => {
  const msg = chatInput.value.trim();
  if (!msg || !dataChannel) return;
  messages.innerHTML += `<div><b>${username}:</b> ${msg}</div>`;
  dataChannel.send(JSON.stringify({ type: "chat", message: msg }));
  chatInput.value = "";
};

chatInput.oninput = () => {
  if (dataChannel) dataChannel.send(JSON.stringify({ type: "typing" }));
};

camBtn.onclick = () => {
  const videoTrack = localStream.getVideoTracks()[0];
  videoTrack.enabled = !videoTrack.enabled;
  camBtn.classList.toggle("off");
};

micBtn.onclick = () => {
  const audioTrack = localStream.getAudioTracks()[0];
  audioTrack.enabled = !audioTrack.enabled;
  micBtn.classList.toggle("off");
};

screenBtn.onclick = async () => {
  const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
  const screenTrack = screenStream.getVideoTracks()[0];
  const sender = peerConnection.getSenders().find((s) => s.track.kind === "video");
  sender.replaceTrack(screenTrack);
  screenTrack.onended = () => sender.replaceTrack(localStream.getVideoTracks()[0]);
};

chatBtn.onclick = () => {
  chatBox.style.display = chatBox.style.display === "block" ? "none" : "block";
};

endBtn.onclick = () => {
  if (peerConnection) peerConnection.close();
  if (socket) socket.close();
  if (transcriptionSocket) transcriptionSocket.close();
  location.reload();
};