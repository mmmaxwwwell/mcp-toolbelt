import { parseUser, greet, sum } from "./index.js";

const u = parseUser({ id: 1, name: "Ada" });
if (greet(u) !== "Hello, Ada!") throw new Error("greet failed");
if (sum(2, 3) !== 5) throw new Error("sum failed");
console.log("ok");
