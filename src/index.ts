import { createServer } from "http";
import { Server } from "socket.io";
import { v4 as uuidv4 } from "uuid";
// Note: You might need to create a simplified supabaseAdmin client here
// or pass keys via environment variables if you use it.

// --- Environment Configuration ---
const port = process.env.PORT || 8080;
// IMPORTANT: Set this in Render to your Vercel app's URL
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
  persistentId?: string;
}

// --- Server State ---
const users = new Map<string, User>();
const waitingPool: string[] = [];
const rooms = new Map<string, { users: [string, string] }>();

// --- Server Setup ---
const httpServer = createServer();
const io = new Server(httpServer, {
  cors: {
    origin: clientURL,
    methods: ["GET", "POST"]
  }
});

console.log(`CORS configured for origin: ${clientURL}`);

// --- All your signaling logic (Copied from your original server.ts) ---
// (The entire io.on("connection", ...) block and helper functions like tryMatch)
const tryMatch = () => {
    while (waitingPool.length >= 2) {
      const user1Id = waitingPool.shift()!
      const user2Id = waitingPool.shift()!
      const user1 = users.get(user1Id)
      const user2 = users.get(user2Id)
      if (!user1 || user1.state !== 'SEARCHING') {
        if(user2Id) waitingPool.unshift(user2Id)
        continue;
      }
       if (!user2 || user2.state !== 'SEARCHING') {
        if(user1Id) waitingPool.unshift(user1Id)
        continue;
      }
      const roomId = uuidv4()
      rooms.set(roomId, { users: [user1Id, user2Id] })
      user1.state = "IN_CHAT"
      user1.roomId = roomId
      user2.state = "IN_CHAT"
      user2.roomId = roomId
      console.log(`Match found! Room: ${roomId}, Users: [${user1Id}, ${user2Id}]`)
      io.to(user1Id).emit("match-found", { roomId, partnerId: user2Id, initiator: true, partnerProfile: user2.profile })
      io.to(user2Id).emit("match-found", { roomId, partnerId: user1Id, initiator: false, partnerProfile: user1.profile })
    }
  }

const handleDisconnect = (socketId: string) => {
    const user = users.get(socketId);
    if (!user) return;
    console.log(`User disconnected: ${socketId}, State: ${user.state}`);
    const waitingIndex = waitingPool.indexOf(socketId);
    if (waitingIndex > -1) {
        waitingPool.splice(waitingIndex, 1);
    }
    if (user.state === "IN_CHAT" && user.roomId) {
        const room = rooms.get(user.roomId);
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
            rooms.delete(user.roomId);
        }
    }
    users.delete(socketId);
};

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

    // ... copy all other socket.on events here: "stop-searching", "skip-chat", "offer", "answer", etc.

    socket.on("disconnect", () => handleDisconnect(socket.id));
});


// --- Server Start ---
httpServer.listen(port, () => {
  console.log(`> Signaling server ready on http://localhost:${port}`);
});
