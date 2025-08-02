/**
 * Represents a circular buffer implementation.
 */
class MuseCircularBuffer {
  /**
   * Constructs a new MuseCircularBuffer with the specified size.
   * @param {number} size - The size of the circular buffer.
   */
  constructor(size) {
    this.memory = new Array(size);
    for (var i = 0; i < size; i++) this.memory[i] = 0;
    this.head = 0;
    this.tail = 0;
    this.isFull = false;
    this.lastwrite = 0;
    this.length = 0;
  }

  /**
   * Reads the next value from the circular buffer.
   * @returns {number|null} The read value, or null if the buffer is empty.
   */
  read() {
    if (this.tail === this.head && !this.isFull) {
      return null;
    } else {
      this.tail = this.next(this.tail);
      this.isFull = false;
      this.length -= 1;
      return this.memory[this.tail];
    }
  }

  /**
   * Writes a value to the circular buffer.
   * @param {number} value - The value to be written.
   */
  write(value) {
    this.lastwrite = Date.now();
    if (this.isFull) {
      return;
    } else {
      this.head = this.next(this.head);
      this.memory[this.head] = value;
      if (this.head === this.tail) {
        this.isFull = true;
      }
      this.length += 1;
    }
  }

  /**
   * Returns the next index in the circular buffer.
   * @param {number} n - The current index.
   * @returns {number} The next index.
   */
  next(n) {
    var nxt = n + 1;
    if (nxt === this.memory.length) {
      return 0;
    } else {
      return nxt;
    }
  }
}

export { MuseCircularBuffer };
