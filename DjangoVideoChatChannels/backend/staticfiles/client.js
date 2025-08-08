let localStream, remoteStream, peerConnection;
let username = "";
let isInitiator = false;
let socket;
let remoteUsername = "";
let dataChannel;
let iceCandidatesQueue = [];
let transcriptionSocket;


const servers = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ]
};


// Get DOM elements
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

// Join popup
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
  // ✅ Step 1: First, get local media
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVideo.srcObject = localStream;
    
    console.log("🟢 Local media stream started");
  } catch (err) {
    console.error("❌ Error accessing camera/microphone:", err);
    return;
  }

  // ✅ Step 2: Then connect WebSocket
  socket = new WebSocket(
    (location.protocol === "https:" ? "wss://" : "ws://") +
    location.host +
    "/ws/signaling/"
  );

   transcriptionSocket = new WebSocket(
  (location.protocol === "https:" ? "wss://" : "ws://") +
  location.host +
  "/ws/transcribe/"
);

 startTranscription();

  // 3️⃣ Set up transcription handlers
  transcriptionSocket.onopen = () => {
    console.log("🟢 Transcription WebSocket connected");
  };
  transcriptionSocket.onerror = (err) => {
    console.error("❌ Transcription WebSocket error", err);
  };
  transcriptionSocket.onclose = () => {
    console.warn("🔴 Transcription WebSocket closed");
  };
    transcriptionSocket.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data.type === "transcript") {
    const who = data.sender === "local" ? `${username}` : `${remoteUsername || "Remote"}`;
    transcriptBox.innerHTML += `<div><b>${who}:</b> ${data.text}</div>`;
    transcriptBox.scrollTop = transcriptBox.scrollHeight;
    console.log("📥 Got transcription:", event.data);
  }
};


  
  // ✅ Step 3: Then set up signaling handlers
  socket.onmessage = async ({ data }) => {
    const msg = JSON.parse(data);

    if (msg.type === "join" && msg.username !== username) {
      remoteUsername = msg.username;
      isInitiator = true;
      createPeerConnection();
      addLocalTracks();
      dataChannel = peerConnection.createDataChannel("chat");
      setupDataChannel();
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      send({ type: "offer", offer, to: remoteUsername });
    }

    if (msg.type === "offer" && msg.to === username) {
      remoteUsername = msg.username;
      createPeerConnection();
      addLocalTracks();
      peerConnection.ondatachannel = (e) => {
        dataChannel = e.channel;
        setupDataChannel();
      };
      await peerConnection.setRemoteDescription(new RTCSessionDescription(msg.offer));
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      send({ type: "answer", answer, to: remoteUsername });
      iceCandidatesQueue.forEach((c) => peerConnection.addIceCandidate(c));
      iceCandidatesQueue = [];
    }

    if (msg.type === "answer" && msg.to === username) {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(msg.answer));
      iceCandidatesQueue.forEach((c) => peerConnection.addIceCandidate(c));
      iceCandidatesQueue = [];
    }

    if (msg.type === "candidate" && msg.to === username) {
      const candidate = new RTCIceCandidate(msg.candidate);
      if (peerConnection.remoteDescription) {
        await peerConnection.addIceCandidate(candidate);
      } else {
        iceCandidatesQueue.push(candidate);
      }
    }
  };

  // ✅ Step 4: Once WebSocket is ready, join
  socket.onopen = () => {
    send({ type: "join", username });
    console.log("🔗 WebSocket connected");
  };
 // ✅ Step 5: Start transcription AFTER media stream is ready
 
}


function send(msg) {
  socket.send(JSON.stringify({ ...msg, username }));
}

function createPeerConnection() {
  peerConnection = new RTCPeerConnection(servers);

  peerConnection.onicecandidate = ({ candidate }) => {
    if (candidate) send({ type: "candidate", candidate, to: remoteUsername });
  };

  peerConnection.ontrack = ({ streams: [stream] }) => {
    remoteVideo.srcObject = stream;
    document.getElementById("remoteName").textContent = remoteUsername;
  };
}

function addLocalTracks() {
  if (!localStream) {
    console.warn("🚫 Tried to add local tracks but localStream is not ready");
    return;
  }

  localStream.getTracks().forEach((track) =>
    peerConnection.addTrack(track, localStream)
  );
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
  socket.close();
  location.reload();
};

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
      console.log("🔊 Sending audio...");

    }
  };
}
function convertFloat32ToInt16(buffer) {
  let l = buffer.length;
  const buf = new Int16Array(l);
  while (l--) buf[l] = Math.min(1, buffer[l]) * 0x7fff;
  return buf.buffer;
}

