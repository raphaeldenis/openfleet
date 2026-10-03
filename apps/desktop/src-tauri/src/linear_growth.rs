use std::time::Duration;

const DEFAULT_ROUNDS: usize = 5;
const DEFAULT_NOISE_FLOOR: Duration = Duration::from_millis(5);
const DEFAULT_MAX_GROWTH_RATIO: u32 = 8;
const DEFAULT_CEILING: Duration = Duration::from_secs(20);

pub struct LinearGrowthBudget {
  pub small_size: usize,
  pub large_size: usize,
  pub rounds: usize,
  pub noise_floor: Duration,
  pub max_growth_ratio: u32,
  pub ceiling: Duration,
}

impl LinearGrowthBudget {
  pub fn between(small_size: usize, large_size: usize) -> Self {
    Self { small_size, large_size, rounds: DEFAULT_ROUNDS, noise_floor: DEFAULT_NOISE_FLOOR, max_growth_ratio: DEFAULT_MAX_GROWTH_RATIO, ceiling: DEFAULT_CEILING }
  }
}

/// Returns the CPU time the calling thread spends in `run`.
/// CPU time ignores the slices the scheduler gives to other processes, which stretch a long run more than a short one.
pub fn thread_cpu_time_of(run: impl FnOnce()) -> Duration {
  let started_at = thread_cpu_time();
  run();
  thread_cpu_time() - started_at
}

fn thread_cpu_time() -> Duration {
  let mut now = libc::timespec { tv_sec: 0, tv_nsec: 0 };
  let status = unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut now) };
  assert_eq!(status, 0, "the thread CPU clock is readable");
  Duration::new(now.tv_sec as u64, now.tv_nsec as u32)
}

/// Runs `measure` on both sizes round after round, so machine contention hits both alike, and keeps the fastest run of each.
pub fn best_durations_at_both_sizes(measure: &mut impl FnMut(usize) -> Duration, budget: &LinearGrowthBudget) -> (Duration, Duration) {
  let mut small = Duration::MAX;
  let mut large = Duration::MAX;
  for _ in 0..budget.rounds {
    small = small.min(measure(budget.small_size));
    large = large.min(measure(budget.large_size));
  }
  (small, large)
}

/// Returns the reasons the cost is not linear; an empty list means it is.
/// The growth ratio only counts when the fastest small run clears the noise floor: the ratio of two tiny times is noise.
/// The absolute ceiling on the large size always counts.
pub fn linear_growth_problems(mut measure: impl FnMut(usize) -> Duration, budget: &LinearGrowthBudget) -> Vec<String> {
  let (small, large) = best_durations_at_both_sizes(&mut measure, budget);
  let mut problems = Vec::new();

  let is_small_run_reliable = small >= budget.noise_floor;
  let is_growth_above_the_bound = large >= small * budget.max_growth_ratio;
  if is_small_run_reliable && is_growth_above_the_bound {
    problems.push(format!("{}x the input took {large:?} against {small:?}, the bound is {}x", budget.large_size / budget.small_size, budget.max_growth_ratio));
  }
  if large >= budget.ceiling {
    problems.push(format!("the large input took {large:?}, the ceiling is {:?}", budget.ceiling));
  }
  problems
}

pub fn assert_linear_growth(measure: impl FnMut(usize) -> Duration, budget: &LinearGrowthBudget) {
  let problems = linear_growth_problems(measure, budget);

  assert!(problems.is_empty(), "growth is not linear: {}", problems.join("; "));
}

/// Builds the hostile text of `unit` repeated up to `size` bytes, once per size, and measures the CPU time of `run` on it.
pub fn cpu_time_to_run_on_repeated<'a>(unit: &'a str, mut run: impl FnMut(&str) + 'a) -> impl FnMut(usize) -> Duration + 'a {
  move |size| {
    let hostile = unit.repeat(size / unit.len() + 1);
    thread_cpu_time_of(|| run(&hostile))
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::cell::RefCell;
  use std::collections::HashMap;

  const SMALL: usize = 1000;
  const LARGE: usize = 4000;

  fn budget() -> LinearGrowthBudget {
    LinearGrowthBudget::between(SMALL, LARGE)
  }

  fn linear_cost(size: usize) -> Duration {
    Duration::from_micros(size as u64 * 100)
  }

  fn quadratic_cost(size: usize) -> Duration {
    Duration::from_micros((size * size) as u64 / 10)
  }

  /// Replays a fixed sequence of timings per size, as a loaded machine would produce them.
  fn replayed(timings_by_size: Vec<(usize, Vec<u64>)>) -> impl FnMut(usize) -> Duration {
    let timings: HashMap<usize, Vec<u64>> = timings_by_size.into_iter().collect();
    let next_index_by_size = RefCell::new(HashMap::<usize, usize>::new());
    move |size| {
      let mut next_indexes = next_index_by_size.borrow_mut();
      let index = next_indexes.entry(size).or_insert(0);
      let milliseconds = timings[&size][*index];
      *index += 1;
      Duration::from_millis(milliseconds)
    }
  }

  #[test]
  fn accepts_a_linear_cost() {
    assert_eq!(linear_growth_problems(linear_cost, &budget()), Vec::<String>::new());
  }

  #[test]
  fn rejects_a_quadratic_cost_and_names_the_bound() {
    let problems = linear_growth_problems(quadratic_cost, &budget());

    assert_eq!(problems.len(), 1);
    assert!(problems[0].contains("the bound is 8x"), "{problems:?}");
  }

  #[test]
  #[should_panic(expected = "growth is not linear")]
  fn panics_on_a_quadratic_cost() {
    assert_linear_growth(quadratic_cost, &budget());
  }

  #[test]
  fn rejects_a_cost_above_the_ceiling_even_when_the_ratio_is_linear() {
    let budget = LinearGrowthBudget { ceiling: Duration::from_millis(300), ..budget() };

    assert_eq!(linear_growth_problems(linear_cost, &budget).len(), 1);
  }

  #[test]
  fn ignores_the_ratio_when_the_fastest_small_run_stays_under_the_noise_floor() {
    let tiny_small_runs_then_ordinary_large_runs = |size: usize| if size == SMALL { Duration::from_micros(500) } else { Duration::from_millis(20) };

    assert_eq!(linear_growth_problems(tiny_small_runs_then_ordinary_large_runs, &budget()), Vec::<String>::new());
  }

  #[test]
  fn keeps_the_fastest_run_of_each_size_so_a_few_contended_runs_do_not_fail_a_linear_cost() {
    let contended_large_runs = replayed(vec![(SMALL, vec![50, 52, 51, 50, 53]), (LARGE, vec![900, 200, 205, 700, 800])]);

    assert_eq!(linear_growth_problems(contended_large_runs, &budget()), Vec::<String>::new());
  }

  #[test]
  fn still_rejects_a_quadratic_cost_when_contention_inflates_some_runs() {
    let contended_quadratic_runs = replayed(vec![(SMALL, vec![50, 90, 51, 70, 80]), (LARGE, vec![900, 800, 810, 1200, 805])]);

    assert_eq!(linear_growth_problems(contended_quadratic_runs, &budget()).len(), 1);
  }

  #[test]
  fn times_the_small_and_the_large_input_alternately() {
    let mut sizes_in_call_order = Vec::new();

    linear_growth_problems(
      |size| {
        sizes_in_call_order.push(size);
        linear_cost(size)
      },
      &LinearGrowthBudget { rounds: 3, ..budget() },
    );

    assert_eq!(sizes_in_call_order, vec![SMALL, LARGE, SMALL, LARGE, SMALL, LARGE]);
  }

  fn burn(iterations: usize) -> usize {
    (0..iterations).fold(0, |sink, step| std::hint::black_box((sink + step) % 1_000_003))
  }

  #[test]
  fn accepts_a_function_whose_real_work_grows_linearly() {
    let measure = cpu_time_to_run_on_repeated("a", |text| {
      burn(text.len() * 20_000);
    });

    assert_eq!(linear_growth_problems(measure, &LinearGrowthBudget::between(4_000, 16_000)), Vec::<String>::new());
  }

  #[test]
  fn rejects_a_function_whose_real_work_grows_quadratically() {
    let measure = cpu_time_to_run_on_repeated("a", |text| {
      burn(text.len() * text.len() / 2);
    });

    assert!(!linear_growth_problems(measure, &LinearGrowthBudget::between(4_000, 16_000)).is_empty());
  }
}
