//! Number Snake. Logic is tested natively; the cdylib exports a draw-command buffer for JS.

const STEP_MS: u32 = 250;
const STALL_STEPS: u32 = 1;
const CELEBRATE_MS: u32 = 2000;
const GRID_W: i32 = 32;
const GRID_H: i32 = 18;
const START_LEN: usize = 3;

const OP_CLEAR: f32 = 0.0;
const OP_RECT: f32 = 1.0;
const OP_ROUND: f32 = 2.0;
const OP_NUMBER: f32 = 3.0;
const OP_PROGRESS: f32 = 4.0;

const CELL_W: f32 = 60.0;
const CELL_H: f32 = 54.0;
const ORIGIN_Y: f32 = 108.0;
const VIEW_W: f32 = 1920.0;
const VIEW_H: f32 = 1080.0;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Dir {
    None,
    Up,
    Right,
    Down,
    Left,
}

impl Dir {
    fn from_u32(value: u32) -> Self {
        match value {
            1 => Dir::Up,
            2 => Dir::Right,
            3 => Dir::Down,
            4 => Dir::Left,
            _ => Dir::None,
        }
    }

    fn delta(self) -> (i32, i32) {
        match self {
            Dir::Up => (0, -1),
            Dir::Right => (1, 0),
            Dir::Down => (0, 1),
            Dir::Left => (-1, 0),
            Dir::None => (0, 0),
        }
    }

    fn opposite(self) -> Self {
        match self {
            Dir::Up => Dir::Down,
            Dir::Right => Dir::Left,
            Dir::Down => Dir::Up,
            Dir::Left => Dir::Right,
            Dir::None => Dir::None,
        }
    }
}

struct Snake {
    joined: bool,
    body: Vec<(i32, i32)>,
    dir: Dir,
    queued: Dir,
    stall: u32,
}

struct Tile {
    x: i32,
    y: i32,
    value: i32,
    wobble: u32,
}

struct Bit {
    x: f32,
    y: f32,
    vx: f32,
    vy: f32,
    w: f32,
    colour: f32,
}

struct Flash {
    x: f32,
    y: f32,
    age: u32,
}

struct Game {
    rng: u32,
    snakes: [Snake; 4],
    numbers: Vec<Tile>,
    round: usize,
    cursor: usize,
    acc_ms: u32,
    anim_ms: u32,
    celebrating: bool,
    celebrate_ms: u32,
    confetti: Vec<Bit>,
    flashes: Vec<Flash>,
    draw: Vec<f32>,
}

fn empty_snake() -> Snake {
    Snake { joined: false, body: Vec::new(), dir: Dir::None, queued: Dir::None, stall: 0 }
}

/// Six rounds, then the set loops. The last counts down from 10, as in "from 10 (10→1)".
fn sequence(round: usize) -> Vec<i32> {
    match round % 6 {
        0 => (1..=10).collect(),
        1 => (1..=10).map(|n| n * 2).collect(),
        2 => (1..=20).collect(),
        3 => (1..=10).map(|n| n * 5).collect(),
        4 => (1..=10).map(|n| n * 10).collect(),
        _ => (1..=10).rev().collect(),
    }
}

const SPAWNS: [(i32, i32, Dir); 4] = [
    (4, 9, Dir::Right),
    (27, 9, Dir::Left),
    (4, 3, Dir::Right),
    (27, 14, Dir::Left),
];

impl Game {
    fn new(seed: u32) -> Self {
        let mut game = Game {
            rng: if seed == 0 { 1 } else { seed },
            snakes: [empty_snake(), empty_snake(), empty_snake(), empty_snake()],
            numbers: Vec::new(),
            round: 0,
            cursor: 0,
            acc_ms: 0,
            anim_ms: 0,
            celebrating: false,
            celebrate_ms: 0,
            confetti: Vec::new(),
            flashes: Vec::new(),
            draw: Vec::new(),
        };
        game.snakes[0].joined = true;
        game.snakes[0].dir = Dir::Right;
        game.place_snake(0, Dir::Right);
        game.spawn_numbers();
        game.rebuild();
        game
    }

    /// A fixed layout for rule tests. `bodies[0]` is player 1; later entries join too.
    #[cfg(test)]
    fn from_parts(bodies: Vec<Vec<(i32, i32)>>, dir: Dir, numbers: Vec<(i32, i32, i32)>, round: usize, cursor: usize) -> Self {
        let mut game = Game::new(1);
        game.numbers.clear();
        game.confetti.clear();
        game.flashes.clear();
        game.celebrating = false;
        game.celebrate_ms = 0;
        game.round = round;
        game.cursor = cursor;
        game.acc_ms = 0;
        for snake in &mut game.snakes {
            *snake = empty_snake();
        }
        for (i, body) in bodies.into_iter().enumerate() {
            game.snakes[i] = Snake { joined: true, body, dir, queued: Dir::None, stall: 0 };
        }
        game.numbers = numbers.into_iter().map(|(x, y, value)| Tile { x, y, value, wobble: 0 }).collect();
        game.rebuild();
        game
    }

    fn rand(&mut self) -> u32 {
        // xorshift32. Zero would stick, so a fresh game never stores it.
        let mut x = self.rng;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.rng = x;
        x
    }

    fn next_value(&self) -> Option<i32> {
        sequence(self.round).get(self.cursor).copied()
    }

    fn occupied(&self, x: i32, y: i32, ignore: Option<usize>) -> bool {
        for (i, snake) in self.snakes.iter().enumerate() {
            if ignore == Some(i) || !snake.joined {
                continue;
            }
            if snake.body.iter().any(|cell| cell.0 == x && cell.1 == y) {
                return true;
            }
        }
        self.numbers.iter().any(|tile| tile.x == x && tile.y == y)
    }

    fn try_place(&mut self, player: usize, x: i32, y: i32, dir: Dir) -> bool {
        let (dx, dy) = dir.opposite().delta();
        let mut cells = Vec::with_capacity(START_LEN);
        for i in 0..START_LEN as i32 {
            let cx = (x + dx * i).rem_euclid(GRID_W);
            let cy = (y + dy * i).rem_euclid(GRID_H);
            if cells.iter().any(|cell: &(i32, i32)| *cell == (cx, cy)) || self.occupied(cx, cy, Some(player)) {
                return false;
            }
            cells.push((cx, cy));
        }
        self.snakes[player] = Snake { joined: true, body: cells, dir, queued: Dir::None, stall: 0 };
        true
    }

    fn place_snake(&mut self, player: usize, dir: Dir) {
        let dir = if dir == Dir::None { Dir::Right } else { dir };
        let (sx, sy, _) = SPAWNS[player];
        if self.try_place(player, sx, sy, dir) {
            return;
        }
        for y in 0..GRID_H {
            for x in 0..GRID_W {
                if self.try_place(player, x, y, dir) {
                    return;
                }
            }
        }
        // The board is huge relative to four snakes; a single free cell is the last resort.
        self.snakes[player] = Snake {
            joined: true,
            body: vec![(0, 0)],
            dir,
            queued: Dir::None,
            stall: 0,
        };
    }

    fn spawn_numbers(&mut self) {
        let seq = sequence(self.round);
        let mut free = Vec::new();
        for y in 0..GRID_H {
            for x in 0..GRID_W {
                if !self.occupied(x, y, None) {
                    free.push((x, y));
                }
            }
        }
        for i in (1..free.len()).rev() {
            let j = self.rand() as usize % (i + 1);
            free.swap(i, j);
        }
        self.numbers = seq.into_iter().take(free.len()).enumerate().map(|(i, value)| Tile {
            x: free[i].0,
            y: free[i].1,
            value,
            wobble: 0,
        }).collect();
    }

    fn input(&mut self, player: u32, dir: u32, button: u32) {
        if player > 3 {
            return;
        }
        let p = player as usize;
        let wanted = Dir::from_u32(dir);
        if !self.snakes[p].joined {
            if wanted == Dir::None && button == 0 {
                return;
            }
            self.place_snake(p, wanted);
            return;
        }
        if wanted == Dir::None {
            return;
        }
        // One buffered turn. Opposite the way they are already going is ignored.
        if self.snakes[p].dir != Dir::None && wanted == self.snakes[p].dir.opposite() {
            return;
        }
        self.snakes[p].queued = wanted;
    }

    fn apply_queue(&mut self, player: usize) {
        let queued = self.snakes[player].queued;
        if queued == Dir::None {
            return;
        }
        if self.snakes[player].dir == Dir::None || queued != self.snakes[player].dir.opposite() {
            self.snakes[player].dir = queued;
        }
        self.snakes[player].queued = Dir::None;
    }

    fn blocked(&self, player: usize, x: i32, y: i32, growing: bool) -> bool {
        for (i, snake) in self.snakes.iter().enumerate() {
            if !snake.joined || snake.body.is_empty() {
                continue;
            }
            let tail = snake.body.len() - 1;
            for (s, cell) in snake.body.iter().enumerate() {
                if cell.0 == x && cell.1 == y {
                    // Their own tail is about to leave, unless this bite keeps it.
                    let own_tail = i == player && s == tail && !growing;
                    if !own_tail {
                        return true;
                    }
                }
            }
        }
        false
    }

    fn begin_celebration(&mut self) {
        self.celebrating = true;
        self.celebrate_ms = 0;
        self.confetti.clear();
        for i in 0..48 {
            let x = (self.rand() % 1920) as f32;
            let y = (self.rand() % 360) as f32;
            let vx = (self.rand() % 500) as f32 - 250.0;
            let vy = 60.0 + (self.rand() % 280) as f32;
            let w = 10.0 + (self.rand() % 18) as f32;
            self.confetti.push(Bit { x, y, vx, vy, w, colour: 11.0 + (i % 5) as f32 });
        }
    }

    fn advance_round(&mut self) {
        self.celebrating = false;
        self.celebrate_ms = 0;
        self.confetti.clear();
        self.flashes.clear();
        self.numbers.clear();
        self.round = (self.round + 1) % 6;
        self.cursor = 0;
        let dirs: Vec<Dir> = self.snakes.iter().map(|snake| snake.dir).collect();
        let joined: Vec<bool> = self.snakes.iter().map(|snake| snake.joined).collect();
        for snake in &mut self.snakes {
            snake.body.clear();
        }
        for player in 0..4 {
            if joined[player] {
                self.place_snake(player, dirs[player]);
            }
        }
        self.spawn_numbers();
    }

    fn step(&mut self) {
        for player in 0..4 {
            if self.celebrating {
                return;
            }
            if !self.snakes[player].joined || self.snakes[player].body.is_empty() {
                continue;
            }
            if self.snakes[player].stall > 0 {
                self.snakes[player].stall -= 1;
                self.apply_queue(player);
                continue;
            }
            self.apply_queue(player);
            let dir = self.snakes[player].dir;
            if dir == Dir::None {
                continue;
            }
            let (hx, hy) = self.snakes[player].body[0];
            let (dx, dy) = dir.delta();
            let nx = (hx + dx).rem_euclid(GRID_W);
            let ny = (hy + dy).rem_euclid(GRID_H);
            let wanted = self.next_value();
            let growing = self.numbers.iter().any(|tile| tile.x == nx && tile.y == ny && Some(tile.value) == wanted);
            if self.blocked(player, nx, ny, growing) {
                // This step already did not move; one more keeps the pause near half a second.
                self.snakes[player].stall = STALL_STEPS;
                continue;
            }
            self.snakes[player].body.insert(0, (nx, ny));
            if let Some(index) = self.numbers.iter().position(|tile| tile.x == nx && tile.y == ny) {
                if Some(self.numbers[index].value) == wanted {
                    let (px, py, _, _) = cell_box(nx, ny, 0.0, 0.0);
                    self.flashes.push(Flash { x: px, y: py, age: 0 });
                    self.numbers.remove(index);
                    self.cursor += 1;
                    if self.cursor >= sequence(self.round).len() {
                        self.begin_celebration();
                    }
                } else {
                    self.numbers[index].wobble = 480;
                    self.snakes[player].body.pop();
                }
            } else {
                self.snakes[player].body.pop();
            }
        }
    }

    fn drift(&mut self, dt_ms: u32) {
        let seconds = dt_ms as f32 / 1000.0;
        for bit in &mut self.confetti {
            bit.x += bit.vx * seconds;
            bit.y += bit.vy * seconds;
            bit.vy += 520.0 * seconds;
            if bit.y > VIEW_H {
                bit.y = -20.0;
                bit.vy = 80.0;
            }
        }
    }

    fn tick(&mut self, dt_ms: u32) {
        self.anim_ms = self.anim_ms.wrapping_add(dt_ms);
        for flash in &mut self.flashes {
            flash.age = flash.age.saturating_add(dt_ms);
        }
        self.flashes.retain(|flash| flash.age < 420);
        for tile in &mut self.numbers {
            tile.wobble = tile.wobble.saturating_sub(dt_ms);
        }
        if self.celebrating {
            self.celebrate_ms = self.celebrate_ms.saturating_add(dt_ms);
            self.drift(dt_ms);
            if self.celebrate_ms >= CELEBRATE_MS {
                self.advance_round();
            }
            self.rebuild();
            return;
        }
        self.acc_ms = self.acc_ms.saturating_add(dt_ms);
        while self.acc_ms >= STEP_MS && !self.celebrating {
            self.acc_ms -= STEP_MS;
            self.step();
        }
        self.rebuild();
    }

    fn push(&mut self, op: f32, x: f32, y: f32, w: f32, h: f32, colour: f32, a: f32, b: f32) {
        self.draw.extend_from_slice(&[op, x, y, w, h, colour, a, b]);
    }

    fn rebuild(&mut self) {
        self.draw.clear();
        self.push(OP_CLEAR, 0.0, 0.0, VIEW_W, VIEW_H, 0.0, 0.0, 0.0);
        for y in 0..GRID_H {
            for x in 0..GRID_W {
                let (px, py, w, h) = cell_box(x, y, 0.0, 0.0);
                self.push(OP_RECT, px, py, w, h, 1.0, 0.0, 0.0);
            }
        }
        let seq = sequence(self.round);
        let count = seq.len() as f32;
        let gap = 8.0;
        let margin = 28.0;
        let avail = VIEW_W - margin * 2.0;
        let w = ((avail - gap * (count - 1.0)) / count).min(168.0);
        let h = 76.0;
        let total = w * count + gap * (count - 1.0);
        let x0 = (VIEW_W - total) / 2.0;
        for (i, value) in seq.iter().enumerate() {
            let state = if i < self.cursor { 1.0 } else if i == self.cursor { 2.0 } else { 0.0 };
            let colour = if state == 1.0 { 9.0 } else if state == 2.0 { 8.0 } else { 1.0 };
            self.push(OP_PROGRESS, x0 + i as f32 * (w + gap), 16.0, w, h, colour, *value as f32, state);
        }
        let pulse = (self.anim_ms as f32 / 180.0).sin().abs();
        let mut snakes = Vec::new();
        for (player, snake) in self.snakes.iter().enumerate() {
            if snake.joined {
                snakes.push((player, snake.body.clone()));
            }
        }
        for (player, body) in snakes {
            let colour = 2.0 + player as f32;
            for (index, cell) in body.iter().enumerate() {
                let (px, py, w, h) = cell_box(cell.0, cell.1, 0.0, 0.0);
                if index == 0 {
                    let radius = w.min(h) / 2.0;
                    self.push(OP_ROUND, px, py, w, h, colour, radius, 0.0);
                } else {
                    self.push(OP_ROUND, px + 2.0, py + 2.0, w - 4.0, h - 4.0, colour, 12.0, 0.0);
                }
            }
        }
        let next = self.next_value();
        let tiles: Vec<(i32, i32, i32, u32)> = self.numbers.iter().map(|tile| (tile.x, tile.y, tile.value, tile.wobble)).collect();
        for (x, y, value, wobble_ms) in tiles {
            let wobble = if wobble_ms > 0 { (wobble_ms as f32 * 0.05).sin() * 10.0 } else { 0.0 };
            let grow = if Some(value) == next { 3.0 + 5.0 * pulse } else { 0.0 };
            let (px, py, w, h) = cell_box(x, y, wobble, grow);
            let colour = if Some(value) == next { 8.0 } else { 6.0 };
            let mark = if Some(value) == next { 1.0 } else { 0.0 };
            self.push(OP_ROUND, px, py, w, h, colour, 14.0, 0.0);
            self.push(OP_NUMBER, px, py, w, h, 7.0, value as f32, mark);
        }
        let flashes: Vec<(f32, f32, u32)> = self.flashes.iter().map(|flash| (flash.x, flash.y, flash.age)).collect();
        for (x, y, age) in flashes {
            let t = 1.0 - age as f32 / 420.0;
            let size = 20.0 + (1.0 - t) * 70.0;
            self.push(OP_ROUND, x + CELL_W / 2.0 - size / 2.0, y, size, size * t, 10.0, 8.0, t);
        }
        let bits: Vec<(f32, f32, f32, f32)> = self.confetti.iter().map(|bit| (bit.x, bit.y, bit.w, bit.colour)).collect();
        for (x, y, w, colour) in bits {
            self.push(OP_RECT, x, y, w, w * 0.55, colour, 0.0, 0.0);
        }
    }
}

fn cell_box(x: i32, y: i32, shift_x: f32, grow: f32) -> (f32, f32, f32, f32) {
    let px = x as f32 * CELL_W + 3.0 + shift_x - grow;
    let py = ORIGIN_Y + y as f32 * CELL_H + 3.0 - grow;
    (px, py, CELL_W - 6.0 + grow * 2.0, CELL_H - 6.0 + grow * 2.0)
}

fn with_game<R>(f: impl FnOnce(&mut Game) -> R) -> R {
    // One game for the page. thread_local avoids atomics, which this wasm target lacks.
    use std::cell::RefCell;
    thread_local! {
        static GAME: RefCell<Game> = RefCell::new(Game::new(1));
    }
    GAME.with(|slot| f(&mut slot.borrow_mut()))
}

#[no_mangle]
pub extern "C" fn game_new(seed: u32) {
    with_game(|game| *game = Game::new(seed));
}

#[no_mangle]
pub extern "C" fn game_input(player: u32, dir: u32, button: u32) {
    with_game(|game| game.input(player, dir, button));
}

#[no_mangle]
pub extern "C" fn game_tick(dt_ms: u32) {
    with_game(|game| game.tick(dt_ms));
}

#[no_mangle]
pub extern "C" fn draw_ptr() -> *const f32 {
    with_game(|game| game.draw.as_ptr())
}

#[no_mangle]
pub extern "C" fn draw_len() -> u32 {
    with_game(|game| game.draw.len() as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn right_snake(head: (i32, i32), len: usize) -> Vec<(i32, i32)> {
        (0..len).map(|i| (head.0 - i as i32, head.1)).collect()
    }

    fn cells_of(game: &Game) -> Vec<(i32, i32, i32)> {
        let mut cells: Vec<_> = game.numbers.iter().map(|tile| (tile.x, tile.y, tile.value)).collect();
        cells.sort();
        cells
    }

    #[test]
    fn collects_numbers_in_order_and_grows() {
        let mut game = Game::from_parts(
            vec![right_snake((2, 2), 3)],
            Dir::Right,
            vec![(3, 2, 1), (4, 2, 2), (8, 8, 9)],
            0,
            0,
        );
        game.tick(STEP_MS);
        assert_eq!(game.snakes[0].body[0], (3, 2));
        assert_eq!(game.snakes[0].body.len(), 4);
        assert_eq!(game.cursor, 1);
        assert!(!cells_of(&game).iter().any(|cell| cell.2 == 1));
        game.tick(STEP_MS);
        assert_eq!(game.snakes[0].body[0], (4, 2));
        assert_eq!(game.snakes[0].body.len(), 5);
        assert_eq!(game.cursor, 2);
        assert!(cells_of(&game).iter().any(|cell| cell.2 == 9));
    }

    #[test]
    fn wrong_number_wobbles_and_changes_nothing() {
        let mut game = Game::from_parts(
            vec![right_snake((2, 2), 3)],
            Dir::Right,
            vec![(3, 2, 4)],
            0,
            0,
        );
        game.tick(STEP_MS);
        assert_eq!(game.snakes[0].body.len(), 3);
        assert_eq!(game.cursor, 0);
        assert_eq!(game.next_value(), Some(1));
        assert_eq!(cells_of(&game), vec![(3, 2, 4)]);
        assert!(game.numbers[0].wobble > 0);
        assert!(game.snakes[0].joined);
    }

    #[test]
    fn wraps_at_the_grid_edges() {
        let mut game = Game::from_parts(
            vec![vec![(31, 5), (30, 5), (29, 5)]],
            Dir::Right,
            vec![],
            0,
            0,
        );
        game.tick(STEP_MS);
        assert_eq!(game.snakes[0].body[0], (0, 5));
        let mut game = Game::from_parts(vec![vec![(4, 0), (4, 1), (4, 2)]], Dir::Up, vec![], 0, 0);
        game.tick(STEP_MS);
        assert_eq!(game.snakes[0].body[0], (4, GRID_H - 1));
    }

    #[test]
    fn collision_stalls_without_removing_the_snake() {
        // Head faces a middle segment, so the tail-exemption does not apply.
        let body = vec![(5, 5), (4, 5), (4, 6), (5, 6), (6, 6), (6, 5), (6, 4)];
        let mut game = Game::from_parts(vec![body], Dir::Right, vec![], 0, 0);
        game.tick(STEP_MS);
        assert_eq!(game.snakes[0].body[0], (5, 5));
        assert_eq!(game.snakes[0].body.len(), 7);
        assert!(game.snakes[0].joined);
        game.input(0, 1, 0);
        game.tick(STEP_MS);
        assert_eq!(game.snakes[0].body[0], (5, 5), "still stopped");
        assert!(game.snakes[0].joined);
        game.tick(STEP_MS);
        assert_eq!(game.snakes[0].body[0], (5, 4), "turns away and carries on");
        assert_eq!(game.snakes[0].body.len(), 7);
    }

    #[test]
    fn buffers_a_turn_until_the_next_step() {
        let mut game = Game::from_parts(vec![right_snake((3, 3), 3)], Dir::Right, vec![], 0, 0);
        game.input(0, 1, 0);
        game.tick(100);
        assert_eq!(game.snakes[0].body[0], (3, 3));
        game.tick(150);
        assert_eq!(game.snakes[0].dir, Dir::Up);
        assert_eq!(game.snakes[0].body[0], (3, 2));
    }

    #[test]
    fn refuses_a_reversal() {
        let mut game = Game::from_parts(vec![right_snake((3, 3), 3)], Dir::Right, vec![], 0, 0);
        game.input(0, 4, 0);
        game.tick(STEP_MS);
        assert_eq!(game.snakes[0].dir, Dir::Right);
        assert_eq!(game.snakes[0].body[0], (4, 3));
    }

    #[test]
    fn completing_a_round_celebrates_then_advances_and_resets_length() {
        let mut game = Game::from_parts(
            vec![right_snake((2, 2), 3)],
            Dir::Right,
            vec![(3, 2, 10)],
            0,
            9,
        );
        game.tick(STEP_MS);
        assert!(game.celebrating);
        assert_eq!(game.round, 0);
        assert_eq!(game.snakes[0].body.len(), 4);
        assert!(!game.confetti.is_empty());
        game.tick(CELEBRATE_MS - 1);
        assert!(game.celebrating);
        assert_eq!(game.round, 0);
        game.tick(1);
        assert!(!game.celebrating);
        assert_eq!(game.round, 1);
        assert_eq!(game.cursor, 0);
        assert_eq!(game.snakes[0].body.len(), START_LEN);
        let mut values: Vec<_> = game.numbers.iter().map(|tile| tile.value).collect();
        values.sort();
        assert_eq!(values, (1..=10).map(|n| n * 2).collect::<Vec<_>>());
        let mut seen = Vec::new();
        for tile in &game.numbers {
            assert!(!seen.contains(&(tile.x, tile.y)));
            assert!(!game.snakes.iter().any(|snake| snake.body.iter().any(|cell| cell.0 == tile.x && cell.1 == tile.y)));
            seen.push((tile.x, tile.y));
        }
    }

    #[test]
    fn rounds_follow_the_counting_patterns() {
        assert_eq!(sequence(0), (1..=10).collect::<Vec<_>>());
        assert_eq!(sequence(1), (1..=10).map(|n| n * 2).collect::<Vec<_>>());
        assert_eq!(sequence(2), (1..=20).collect::<Vec<_>>());
        assert_eq!(sequence(3), (1..=10).map(|n| n * 5).collect::<Vec<_>>());
        assert_eq!(sequence(4), (1..=10).map(|n| n * 10).collect::<Vec<_>>());
        assert_eq!(sequence(5), (1..=10).rev().collect::<Vec<_>>());
        assert_eq!(sequence(6), sequence(0));
    }

    #[test]
    fn numbers_never_spawn_on_snakes_or_each_other() {
        for seed in [1, 2, 7, 99, 1000] {
            let game = Game::new(seed);
            assert_eq!(game.numbers.len(), 10, "seed {seed}");
            assert_eq!(game.snakes[0].body.len(), START_LEN);
            let mut seen = Vec::new();
            for tile in &game.numbers {
                assert!(!seen.contains(&(tile.x, tile.y)), "seed {seed}");
                assert!(
                    !game.snakes[0].body.iter().any(|cell| cell.0 == tile.x && cell.1 == tile.y),
                    "seed {seed}"
                );
                seen.push((tile.x, tile.y));
            }
        }
    }

    #[test]
    fn the_same_seed_plays_the_same_and_another_seed_does_not() {
        fn play(seed: u32) -> (Vec<(i32, i32)>, Vec<(i32, i32, i32)>, usize, usize) {
            let mut game = Game::new(seed);
            game.input(0, 1, 0);
            game.input(1, 4, 1);
            game.tick(100);
            game.tick(400);
            game.tick(250);
            game.tick(1000);
            (game.snakes[0].body.clone(), cells_of(&game), game.cursor, game.round)
        }
        assert_eq!(play(42), play(42));
        assert_ne!(play(42).1, play(43).1);
    }

    #[test]
    fn draw_buffer_is_strided_and_lists_the_round() {
        let game = Game::new(3);
        assert_eq!(game.draw.len() % 8, 0);
        assert!(game.draw.len() >= 8);
        let mut numbers = 0;
        let mut progress = 0;
        for chunk in game.draw.chunks(8) {
            if chunk[0] == OP_NUMBER {
                numbers += 1;
            }
            if chunk[0] == OP_PROGRESS {
                progress += 1;
            }
        }
        assert_eq!(numbers, 10);
        assert_eq!(progress, 10);
    }

    #[test]
    fn c_abi_runs() {
        game_new(5);
        game_input(1, 1, 1);
        game_tick(500);
        let len = draw_len();
        assert!(len > 0 && len % 8 == 0);
        assert!(!draw_ptr().is_null());
    }
}
