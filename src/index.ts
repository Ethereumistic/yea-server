import { createServer } from "http";
import { Server } from "socket.io";
import { v4 as uuidv4 } from "uuid";
// FIX: Update the import path to reflect that the 'lib' folder is inside 'src'
import { supabaseAdmin } from "./lib/supabase/admin";

// --- Environment Configuration ---
// Render will set the PORT environment variable. Fallback to 8080 for local dev.
const port = process.env.PORT || 8080;
// This will be your Vercel app's URL, set as an env var in Render.
const clientURL = process.env.CORS_ORIGIN || "http://localhost:3000";

// --- Types (Copied from your original project) ---
type UserState = "IDLE" | "SEARCHING" | "IN_CHAT";

type Profile = {
  username: string | null;
  avatar_url?: string;
  dob?: string;
  gender?: 'male' | 'female' | 'couple';
};

interface User {
  state: UserState;
  roomId?: string;
  profile?: Profile;
  persistentId?: string; // The user's actual ID from the database
}

// --- Server State (In-Memory) ---
const users = new Map<string, User>();
const waitingPool: string[] = [];
const rooms = new Map<string, { users: [string, string] }>();

// --- Server Setup ---
const httpServer = createServer();
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

console.log(`CORS configured to allow origin: ${clientURL}`);

// --- Helper Functions ---
const tryMatch = () => {
  while (waitingPool.length >= 2) {
    const user1Id = waitingPool.shift()!;
    const user2Id = waitingPool.shift()!;
    const user1 = users.get(user1Id);
    const user2 = users.get(user2Id);

    if (!user1 || user1.state !== 'SEARCHING') {
      if (user2Id) waitingPool.unshift(user2Id);
      continue;
    }
    if (!user2 || user2.state !== 'SEARCHING') {
      if (user1Id) waitingPool.unshift(user1Id);
      continue;
    }

    const roomId = uuidv4();
    rooms.set(roomId, { users: [user1Id, user2Id] });
    user1.state = "IN_CHAT";
    user1.roomId = roomId;
    user2.state = "IN_CHAT";
    user2.roomId = roomId;

    console.log(`Match found! Room: ${roomId}, Users: [${user1Id}, ${user2Id}]`);
    io.to(user1Id).emit("match-found", { roomId, partnerId: user2Id, initiator: true, partnerProfile: user2.profile });
    io.to(user2Id).emit("match-found", { roomId, partnerId: user1Id, initiator: false, partnerProfile: user1.profile });
  }
};

const handleDisconnect = (socketId: string) => {
  const user = users.get(socketId);
  if (!user) return;

  console.log(`User disconnected: ${socketId}, State: ${user.state}`);
  const waitingIndex = waitingPool.indexOf(socketId);
  if (waitingIndex > -1) {
    waitingPool.splice(waitingIndex, 1);
  }

  if (user.state === "IN_CHAT" && user.roomId) {
    const roomId = user.roomId;
    const room = rooms.get(roomId);
    if (room) {
      const partnerId = room.users.find(id => id !== socketId);
      if (partnerId) {
        io.to(partnerId).emit("partner-disconnected");
        const partner = users.get(partnerId);
        if (partner) {
          partner.state = "SEARCHING";
          delete partner.roomId;
          waitingPool.unshift(partnerId);
          io.to(partnerId).emit("auto-searching");
          tryMatch();
        }
      }
      rooms.delete(roomId);
    }
  }
  users.delete(socketId);
};

// --- Main Connection Logic ---
io.on("connection", (socket) => {
  console.log(`User connected: ${socket.id}`);
  users.set(socket.id, { state: "IDLE" });

  socket.on("start-searching", ({ profile }: { profile: Profile & { id: string } }) => {
    const user = users.get(socket.id);
    if (user && (user.state === "IDLE" || user.state === "SEARCHING")) {
      user.state = "SEARCHING";
      user.profile = profile;
      user.persistentId = profile.id;
      if (!waitingPool.includes(socket.id)) {
        waitingPool.push(socket.id);
      }
      console.log(`User ${socket.id} is now searching. Waiting pool: ${waitingPool.length}`);
      tryMatch();
    }
  });

  socket.on("stop-searching", () => {
    const user = users.get(socket.id);
    if (user && user.state === "SEARCHING") {
      const index = waitingPool.indexOf(socket.id);
      if (index > -1) {
        waitingPool.splice(index, 1);
      }
      user.state = "IDLE";
      console.log(`User ${socket.id} stopped searching. Waiting pool: ${waitingPool.length}`);
    }
  });

  socket.on("skip-chat", () => {
    const user = users.get(socket.id);
    if (!user || user.state !== 'IN_CHAT' || !user.roomId) return;
    
    const roomId = user.roomId;
    const room = rooms.get(roomId);
    if (!room) return;
    
    const partnerId = room.users.find(id => id !== socket.id);
    if (!partnerId) return;

    const partner = users.get(partnerId);
    io.to(partnerId).emit('partner-disconnected');
    user.state = 'SEARCHING';
    delete user.roomId;
    if (!waitingPool.includes(socket.id)) {
      waitingPool.push(socket.id);
    }
    io.to(socket.id).emit("auto-searching");
    if (partner) {
      partner.state = 'SEARCHING';
      delete partner.roomId;
      if (!waitingPool.includes(partnerId)) {
        waitingPool.unshift(partnerId);
      }
      io.to(partnerId).emit("auto-searching");
    }
    rooms.delete(roomId);
    tryMatch();
  });

  socket.on("stop-chat", () => {
    const user = users.get(socket.id);
    if (!user || user.state !== 'IN_CHAT' || !user.roomId) return;

    const roomId = user.roomId;
    const room = rooms.get(roomId);
    if (!room) return;

    const partnerId = room.users.find(id => id !== socket.id);
    if (!partnerId) return;

    const partner = users.get(partnerId);
    io.to(partnerId).emit('partner-disconnected');
    user.state = 'IDLE';
    delete user.roomId;
    if (partner) {
      partner.state = 'SEARCHING';
      delete partner.roomId;
      if (!waitingPool.includes(partnerId)) {
        waitingPool.unshift(partnerId);
      }
      io.to(partnerId).emit("auto-searching");
    }
    rooms.delete(roomId);
    tryMatch();
  });

  // --- WebRTC Signaling Relay ---
  socket.on("offer", (data) => io.to(data.partnerId).emit("offer", { sdp: data.sdp, senderId: socket.id }));
  socket.on("answer", (data) => io.to(data.partnerId).emit("answer", { sdp: data.sdp, senderId: socket.id }));
  socket.on("ice-candidate", (data) => io.to(data.partnerId).emit("ice-candidate", { candidate: data.candidate, senderId: socket.id }));

  // --- Chat Message Relay ---
  socket.on("chat-message", (data) => {
    const user = users.get(socket.id);
    if (user && user.state === "IN_CHAT" && data.partnerId) {
      io.to(data.partnerId).emit("chat-message", { message: data.message, from: socket.id });
    }
  });

  // --- Report Handling ---
  socket.on('initiate-report', async ({ partnerId, screenshot, chatLog }) => {
    const user = users.get(socket.id);
    const partner = users.get(partnerId);
    if (!user || user.state !== 'IN_CHAT' || !user.roomId || !partner || !user.persistentId || !partner.persistentId) {
      return console.error("Report initiated in invalid state.");
    }
    const roomId = user.roomId;
    io.to(partnerId).emit('partner-disconnected');
    io.to(socket.id).emit('partner-disconnected');
    user.state = 'IDLE';
    delete user.roomId;
    partner.state = 'SEARCHING';
    delete partner.roomId;
    if (!waitingPool.includes(partnerId)) {
      waitingPool.unshift(partnerId);
    }
    io.to(partnerId).emit("auto-searching");
    rooms.delete(roomId);
    tryMatch();
    try {
      const { data, error } = await supabaseAdmin.functions.invoke('create-report-mvp', {
        body: {
          reportingUserId: user.persistentId,
          reportedUserId: partner.persistentId,
          screenshotBase64: Buffer.from(screenshot).toString('base64'),
          chatLog: chatLog
        }
      });
      if (error) throw error;
      console.log('Report successfully saved:', data);
      io.to(socket.id).emit('report-successful');
    } catch (error) {
      console.error('Error invoking create-report-mvp function:', error);
      io.to(socket.id).emit('report-failed');
    }
  });

  socket.on("disconnect", () => handleDisconnect(socket.id));
});

// --- Server Start ---
httpServer.listen(port, () => {
  console.log(`> Signaling server ready on http://localhost:${port}`);
});
